require("dotenv").config();
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ORGANIZATION_ID = "42c5f94f-baae-43e6-8aaa-1f5f0b7f28c3";

const content = fs.readFileSync("./users.json", "utf8");
const users = content
  .split("\n")
  .filter(line => line.trim())
  .map(line => JSON.parse(line));

async function addUsersToOrganization() {
  let success = 0;
  let failed = 0;

  for (const user of users) {
    try {
      // profile find by email
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id,email")
        .eq("email", user.email)
        .single();

      if (profileError || !profile) {
        console.log(` Profile not found: ${user.email}`);
        failed++;
        continue;
      }

      const { error: memberError } = await supabase
        .from("organization_members")
        .upsert(
          {
            organization_id: ORGANIZATION_ID,
            user_id: profile.id,
            role: user.role || "user",
            balance: user.balance || 0,
          },
          {
            onConflict: "organization_id,user_id",
          }
        );

      if (memberError) {
        console.log(` ${user.email}: ${memberError.message}`);
        failed++;
        continue;
      }

      console.log(`✅ Added: ${user.email}`);
      success++;
    } catch (err) {
      console.error(err);
      failed++;
    }
  }

  console.log("\n===== DONE =====");
  console.log(`Success: ${success}`);
  console.log(`Failed : ${failed}`);
}

addUsersToOrganization();