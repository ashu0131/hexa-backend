const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// IMPORTANT: mounted with express.raw({ type: "application/json" })
router.post("/", async (req, res) => {
  const sig = req.headers["stripe-signature"];

  // let event;

  // try {
  //   event = stripe.webhooks.constructEvent( 
  //     req.body,
  //     sig,
  //     process.env.STRIPE_WEBHOOK_SECRET,
  //   );
  // } catch (err) {
  //   console.error(" Webhook signature verification failed:", err.message);
  //   return res.status(400).send(`Webhook Error: ${err.message}`);
  // }

  let event = null;
  let matchedOrg = null;

  try {
    // 1️⃣ Get all org webhook secrets
    const { data: orgs, error } = await supabase
      .from("organizations")
      .select("id, stripe_webhook_secret");

    if (error || !orgs) {
      console.error(" Failed to fetch orgs");
      return res.status(500).send("Webhook error");
    }

    // 2️⃣ Try verifying with each secret
    for (const org of orgs) {
      if (!org.stripe_webhook_secret) continue;

      try {
        const stripe = new Stripe("sk_test_dummy"); // only for helper

        const evt = stripe.webhooks.constructEvent(
          req.body,
          sig,
          org.stripe_webhook_secret,
        );

        event = evt;
        matchedOrg = org;
        break;
      } catch (err) {
        // try next org
      }
    }

    if (!event) {
      console.error(" No matching webhook secret");
      return res.status(400).send("Invalid signature");
    }
  } catch (err) {
    console.error(" Webhook verification error:", err);
    return res.status(400).send("Webhook error");
  }

  // ✅ Handle only successful checkout
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    try {
      const user_id = session.metadata?.user_id;
      const organization_id = session.metadata?.org_id;

      // 🔥 ADD THESE LOGS HERE
console.log("Matched Org ID:", matchedOrg?.id);
console.log("Metadata Org ID:", organization_id);
console.log("SESSION METADATA:", session.metadata);

      if (matchedOrg && organization_id !== matchedOrg.id) {
        console.warn("[webhook] org mismatch");
        return res.json({ received: true });
      }
      const txKey = session.id;
      const amountCents = session.amount_total;

      console.log("SESSION METADATA:", session.metadata);
      if (!user_id || !amountCents || !organization_id) {
        console.warn("[webhook] missing metadata");
        return res.json({ received: true });
      }

      const amount = amountCents / 100;

      // 1️⃣ Insert recharge (idempotent)
      const { error: insertError } = await supabase.from("recharges").insert({
        user_id,
        amount,
        organization_id,
        transaction_id: txKey,
        credited: false,
      });

      if (insertError && insertError.code === "23505") {
        console.log("[webhook] duplicate transaction:", txKey);
        return res.json({ received: true });
      }

      if (insertError) {
        console.error("[webhook] insert error:", insertError);
        return res.json({ received: true });
      }

      // 2️⃣ Update balance
      const { error: balanceError } = await supabase.rpc(
        "increment_org_member_balance",
        {
          user_id_input: user_id,
          org_id_input: organization_id,
          amount_input: amount,
        },
      );
      if (balanceError) {
        console.error("[webhook] balance update failed:", balanceError);
        return res.json({ received: true });
      }

      // 3️⃣ Mark credited
      await supabase
        .from("recharges")
        .update({
          credited: true,
          credited_at: new Date().toISOString(),
        })
        .eq("transaction_id", txKey);

      console.log(`[webhook] credited €${amount} to ${user_id}`);
    } catch (err) {
      console.error("[webhook] handler error:", err);
    }
  }

  // Always acknowledge Stripe
  return res.json({ received: true });
});

module.exports = router;
