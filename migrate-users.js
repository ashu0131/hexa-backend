require("dotenv").config();
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const content = fs.readFileSync("./users.json", "utf8");
const users = content
  .split("\n")
  .filter(line => line.trim())
  .map(line => JSON.parse(line));

  console.log(`Found ${users.length} users`);

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function migrateUsers() {
  let success = 0;
  let failed = 0;

  for (const user of users) {
    const email = user.email?.trim();

    if (!email || !emailRegex.test(email)) {
      console.log(` Invalid email: ${email}`);
      failed++;
      continue;
    }

    const { data, error } = await supabase.auth.admin.createUser({
  email: user.email,
  password: "TempPassword@123",
  email_confirm: true,
  user_metadata: {
    username: user.username,  
    room_number: user.roomNumber,
    role: user.role,
  },
});

    if (error) {
        console.log("Email:", email);
  console.log("Error:", error);
  continue;
    } else {
      console.log(`✅ Imported: ${email}`);
      success++;
    }
  }

  console.log("\n===== DONE =====");
  console.log(`Success: ${success}`);
  console.log(`Failed : ${failed}`);
}

migrateUsers();