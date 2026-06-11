console.log("MQTT CLIENT VERSION TEST");

const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");

const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const sendMachineStopMail = require("../utils/sendMachineStopMail");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

let activeSessions = {};
let deviceRelayStates = {};
let syncingMachines = {};

let machineRuntimeStates = {};

const POWER_THRESHOLD = 20;
//const LOW_POWER_DURATION = 2 * 60 * 1000; // 2 min
const STARTUP_GRACE_PERIOD = 2 * 60 * 1000; // user has 2 min to start machine
const END_CYCLE_DETECTION = 90 * 1000; // 90 sec low power = machine finished
const MAX_RUNTIME = 180 * 60 * 1000; // 180 min

const client = mqtt.connect(MQTT_URL, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  reconnectPeriod: 2000,
});

const pendingCommands = new Map();

// --- EMERGENCY SYNC TIMER (Optional Safety)
setInterval(async () => {
  for (const chipid in activeSessions) {
    if (activeSessions[chipid].length > 500) {
      console.log(
        ` Emergency flushing partial data for ${chipid} to prevent RAM overload`,
      );

      await syncSessionToSupabase(chipid);
    }
  }
}, 10800000);

client.on("connect", () => {
  console.log("✅ MQTT connected");

  client.subscribe(
    ["dlps/+/POWER", "dlps/+/STATE", "dlps/+/LWT", "dlps/+/STATUS8"],
    (err) => {
      if (err) console.error("MQTT subscribe error:", err);
      else console.log("Subscribed to plug topics");
    },
  );
});
async function getPollInterval() {
  try {
    const { data, error } = await supabase
      .from("teleperiod")
      .select("status_poll_interval")
      .order("id", { ascending: true }) // first row
      .limit(1);

    if (error) throw error;

    return data?.[0]?.status_poll_interval ?? 5000;
  } catch (err) {
    console.error("Failed to fetch telemetry interval:", err);
    return 5000;
  }
}
async function startStatusPolling() {
  const interval = await getPollInterval();

  console.log(
    `Telemetry polling every ${interval} ms`
  );

  setInterval(async () => {
    try {
      const { data: machines } = await supabase
        .from("machines")
        .select("chipid")
        .not("chipid", "is", null);

      for (const machine of machines || []) {
        client.publish(
          `dlps/${machine.chipid}/cmnd/Status`,
          "8"
        );
      }
    } catch (err) {
      console.error("Status polling error:", err);
    }
  }, interval);
}
startStatusPolling();
async function syncSessionToSupabase(chipid) {
  if (syncingMachines[chipid]) return;

  if (!activeSessions[chipid] || activeSessions[chipid].length === 0) return;

  syncingMachines[chipid] = true;

  const dataToSync = [...activeSessions[chipid]];

  activeSessions[chipid] = [];

  try {
    const { data: machine } = await supabase
      .from("machines")
      .select("id")
      .eq("chipid", chipid)
      .single();

    if (!machine) return;

    const { data: existingLog } = await supabase
      .from("machine_logs")
      .select("id, logs")
      .eq("machine_id", machine.id)
      .is("end_time", null)
      .single();

    if (!existingLog) return;

    const oldLogs = existingLog.logs || [];

    const { error } = await supabase
      .from("machine_logs")
      .update({
        logs: [...oldLogs, ...dataToSync],
      })
      .eq("id", existingLog.id);

    if (error) throw error;

    console.log(` Synced ${dataToSync.length} readings for ${chipid}`);
  } catch (err) {
    console.error(err);

    activeSessions[chipid] = [...dataToSync, ...activeSessions[chipid]];
  } finally {
    syncingMachines[chipid] = false;
  }
}

client.on("message", async (topic, payloadBuffer) => {
  try {
    const payload = payloadBuffer.toString();
    const parts = topic.split("/");
    const chipid = parts[1];
    const type = parts[2];

    // ======================================
    // TRACK RELAY STATE
    // ======================================

    if (type === "POWER") {
      const newState = payload.toUpperCase();

      const oldState = deviceRelayStates[chipid];

      deviceRelayStates[chipid] = newState;

      // RESET SESSION
      if (oldState !== "ON" && newState === "ON") {
        console.log(`POWER EVENT ${chipid}: OFF -> ON`);

        machineRuntimeStates[chipid] = {
          hasStarted: false,
          lowPowerStart: null,
          startedAt: Date.now(),
          stopping: false,
        };
      }

      if (oldState === "ON" && newState === "OFF") {
        console.log(`Plug ${chipid} turned OFF. Finalizing batch...`);

        await syncSessionToSupabase(chipid);

        delete machineRuntimeStates[chipid];
      }

      handlePowerConfirmation(chipid, payload);
    }
    if (type === "STATE") {
      const stateData = JSON.parse(payload);

      if (stateData.POWER) {
        deviceRelayStates[chipid] = stateData.POWER.toUpperCase();
      }
    }

    // ======================================
    // SENSOR TOPIC
    // ======================================

    if (type === "STATUS8") {
      const data = JSON.parse(payload);
      const energySource =
        type === "STATUS8" ? data.StatusSNS?.ENERGY : data.ENERGY;

      if (energySource) {
        const energy = {
          chipid,
          power: energySource.Power,
          voltage: energySource.Voltage,
          current: energySource.Current,
          today: energySource.Today,
          total: energySource.Total,
        };
        console.log(
          `${new Date().toISOString()} [${type}] ${chipid} ${energy.power}W`,
        );
        console.log(
          `[ENERGY] ${chipid} | Power=${energySource.Power}W | Voltage=${energySource.Voltage}V | Current=${energySource.Current}A`,
        );

        const isPlugOn = deviceRelayStates[chipid] === "ON";

        if (!isPlugOn) {
          return;
        }

        // ======================================
        // BUFFER SESSION DATA
        // ======================================

        if (isPlugOn) {
          if (!activeSessions[chipid]) {
            activeSessions[chipid] = [];
          }

          activeSessions[chipid].push([
            energy.chipid,
            energy.power,
            energy.voltage,
            energy.current,
            energy.today,
            energy.total,
            new Date().toISOString(),
          ]);

          console.log(
            `[REC] ${chipid} active. Buffer: ${activeSessions[chipid].length}`,
          );
        }

        // ======================================
        // FETCH MACHINE
        // ======================================

        const { data: machine } = await supabase
          .from("machines")
          .select("id, cost, organization_id, machine_code")
          .eq("chipid", chipid)
          .single();

        if (!machine) {
          console.log("[DEBUG EXIT] machine not found");
          return;
        }

        const { data: machineStatus } = await supabase
          .from("machine_status")
          .select("*")
          .eq("machine_id", machine.id)
          .single();

        if (!machineStatus) {
          console.log("[DEBUG EXIT] machineStatus missing");
          return;
        }

        console.log("[DEBUG] machineStatus found");

        if (!machineStatus.in_use) {
          console.log("[DEBUG EXIT] machine not in use");
          return;
        }

        console.log(
          `[DEBUG] mode=${machineStatus.mode} in_use=${machineStatus.in_use}`,
        );

        if (machineStatus.mode !== "energy_based") {
          console.log(`[DEBUG EXIT] wrong mode: ${machineStatus.mode}`);
          return;
        }

        // ======================================
        // INIT RUNTIME STATE
        // ======================================

        console.log(`[DEBUG] PASSED ALL CHECKS FOR ${chipid}`);

        if (!machineRuntimeStates[chipid]) {
          machineRuntimeStates[chipid] = {
            hasStarted: false,
            lowPowerStart: null,
            startedAt: Date.now(),
            stopping: false,
          };
        }

        const runtime = machineRuntimeStates[chipid];

        // ======================================
        // MAX RUNTIME CHECK
        // ======================================

        const runtimeDuration = Date.now() - runtime.startedAt;

        if (runtimeDuration >= MAX_RUNTIME) {
          if (runtime.stopping) return;

          runtime.stopping = true;

          console.log(` Machine ${chipid} MAX RUNTIME REACHED`);

          await stopMachine(chipid);

          // END MACHINE STATUS
          await supabase
            .from("machine_status")
            .update({
              in_use: false,
              started_by: null,
              end_time: null,
            })
            .eq("machine_id", machine.id);

          // SEND STOP EMAIL
          const { data: activeLogs } = await supabase
            .from("machine_logs")
            .select("*")
            .eq("machine_id", machine.id)
            .is("end_time", null)
            .order("start_time", { ascending: false })
            .limit(1);

          const activeLog = activeLogs?.[0];

          if (activeLog?.user_id) {
            await sendMachineStopMail({
              userId: activeLog.user_id,
              machineName: machine.machine_code,
            });

            console.log("Stop mail sent");
          }

          // CLOSE LOG
          await syncSessionToSupabase(chipid);

          delete activeSessions[chipid];

          await supabase
            .from("machine_logs")
            .update({
              end_time: new Date().toISOString(),
            })
            .eq("machine_id", machine.id)
            .is("end_time", null);

          delete machineRuntimeStates[chipid];

          console.log(` Machine ${chipid} stopped due to max runtime`);

          return;
        }

        // ======================================
        // MACHINE START DETECTION
        // ======================================

        console.log(
          `[DEBUG] ${chipid} Power=${energy.power} Threshold=${POWER_THRESHOLD}`,
        );
        console.log(`[DEBUG] Comparing ${energy.power} > ${POWER_THRESHOLD}`);
        if (energy.power > POWER_THRESHOLD) {
          runtime.hasStarted = true;

          runtime.lowPowerStart = null;

          console.log(` Machine ${chipid} RUNNING`);

          await supabase
            .from("machine_logs")
            .update({
              energy_started: true,
            })
            .eq("machine_id", machine.id)
            .is("end_time", null);
        }

        // ======================================
        // LOW POWER DETECTION
        // ======================================
        else {
          console.log(`Machine ${chipid} LOW POWER`);

          if (!runtime.lowPowerStart) {
            runtime.lowPowerStart = Date.now();

            console.log(`Low power timer started for ${chipid}`);
          }

          const lowPowerDuration = Date.now() - runtime.lowPowerStart;

          const requiredDuration = runtime.hasStarted
            ? END_CYCLE_DETECTION
            : STARTUP_GRACE_PERIOD;

          console.log(
            `[LOW POWER] ${chipid} duration=${lowPowerDuration} required=${requiredDuration} started=${runtime.hasStarted}`,
          );

          console.log(
            `[DEBUG TIMER] ${chipid} duration=${lowPowerDuration} threshold=${requiredDuration}`,
          );
          console.log(`[DEBUG CHECK] ${lowPowerDuration >= requiredDuration}`);
          if (lowPowerDuration >= requiredDuration) {
            if (runtime.stopping) return;

            runtime.stopping = true;

            console.log(` Machine ${chipid} STOPPED`);

            await stopMachine(chipid);

            // ======================================
            // REFUND LOGIC
            // ======================================

            if (!runtime.hasStarted) {
              console.log(`Refunding user because machine never started`);

              // GET ACTIVE LOG BEFORE CLOSING
              const { data: activeLogs, error: logError } = await supabase
                .from("machine_logs")
                .select("*")
                .eq("machine_id", machine.id)
                .is("end_time", null)
                .order("start_time", { ascending: false })
                .limit(1);

              if (logError) {
                console.error("ACTIVE LOG ERROR:", logError);
              }

              const activeLog = activeLogs?.[0];

              if (activeLog) {
                console.log("Refund log found:", activeLog.id);

                // FETCH MEMBER
                const { data: members, error: memberError } = await supabase
                  .from("organization_members")
                  .select("id, balance, organization_id")
                  .eq("user_id", activeLog.user_id)
                  .eq("organization_id", machine.organization_id)
                  .limit(1);

                if (memberError) {
                  console.error("MEMBER FETCH ERROR:", memberError);
                }

                const member = members?.[0];

                if (member) {
                  const newBalance =
                    Number(member.balance || 0) + Number(machine.cost || 0);

                  console.log("OLD BALANCE:", member.balance);
                  console.log("NEW BALANCE:", newBalance);

                  const { data: updatedMember, error: refundError } =
                    await supabase
                      .from("organization_members")
                      .update({
                        balance: newBalance,
                      })
                      .eq("id", member.id)
                      .select();

                  if (refundError) {
                    console.error("REFUND ERROR:", refundError);
                  } else {
                    console.log("UPDATED MEMBER:", updatedMember);

                    console.log(
                      `Refund completed for user ${activeLog.user_id}`,
                    );
                  }
                }

                // MARK REFUND
                await supabase
                  .from("machine_logs")
                  .update({
                    refund_given: true,
                    refund_amount: machine.cost,
                  })
                  .eq("id", activeLog.id);
              } else {
                console.log("No active log found for refund");
              }
            }

            // ======================================
            // END MACHINE STATUS
            // ======================================

            await supabase
              .from("machine_status")
              .update({
                in_use: false,
                started_by: null,
                end_time: null,
              })
              .eq("machine_id", machine.id);

            // ======================================
            // SEND STOP EMAIL
            // ======================================

            const { data: activeLogs } = await supabase
              .from("machine_logs")
              .select("*")
              .eq("machine_id", machine.id)
              .is("end_time", null)
              .order("start_time", { ascending: false })
              .limit(1);

            const activeLog = activeLogs?.[0];

            if (activeLog?.user_id) {
              await sendMachineStopMail({
                userId: activeLog.user_id,
                machineName: machine.machine_code,
              });

              console.log("Stop mail sent");
            }

            // ======================================
            // CLOSE LOG
            // ======================================

            await syncSessionToSupabase(chipid);

            delete activeSessions[chipid];

            await supabase
              .from("machine_logs")
              .update({
                end_time: new Date().toISOString(),
              })
              .eq("machine_id", machine.id)
              .is("end_time", null);

            delete machineRuntimeStates[chipid];

            console.log(` Machine ${chipid} session completed`);
          }
        }
      }
    }
  } catch (err) {
    console.error("MQTT message error:", err);
  }
});

function handlePowerConfirmation(chipid, state) {
  const pending = pendingCommands.get(chipid);

  if (!pending) return;

  if (state.toUpperCase() === pending.expectedState.toUpperCase()) {
    clearTimeout(pending.timer);

    pending.resolve();

    pendingCommands.delete(chipid);

    console.log("Command confirmed");
  }
}
function verifyPlugOnline(chipid) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      client.removeListener("message", listener);
      resolve(false);
    }, 5000);

    const listener = (topic, payloadBuffer) => {
      const payload = payloadBuffer.toString();

      if (
        topic === `dlps/${chipid}/POWER` ||
        topic === `dlps/${chipid}/STATE`
      ) {
        clearTimeout(timeout);
        client.removeListener("message", listener);

        console.log(`Plug ${chipid} responded`);

        resolve(true);
      }
    };

    client.on("message", listener);

    // Ask device to report current power state
    client.publish(
      `dlps/${chipid}/cmnd/POWER`,
      ""
    );
  });
}
function sendPowerCommand(chipid, state) {
  return new Promise((resolve, reject) => {
    const topic = `dlps/${chipid}/cmnd/POWER`;

    const timer = setTimeout(() => {
      pendingCommands.delete(chipid);

      reject(new Error("Device timeout"));
    }, 8000);

    pendingCommands.set(chipid, {
      resolve,
      reject,
      timer,
      expectedState: state,
    });

    client.publish(topic, state, { qos: 1 }, (err) => {
      if (err) {
        clearTimeout(timer);

        pendingCommands.delete(chipid);

        reject(err);
      }
    });
  });
}
async function stopMachine(chipid) {
  console.log("STOP MACHINE CALLED:", chipid);

  // CLEAN RUNTIME MEMORY
  delete machineRuntimeStates[chipid];
  delete syncingMachines[chipid];

  return sendPowerCommand(chipid, "OFF");
}

module.exports = {
  client,
  sendPowerCommand,
  stopMachine,
   verifyPlugOnline,
};
