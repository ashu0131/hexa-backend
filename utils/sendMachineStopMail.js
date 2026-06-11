const SibApiV3Sdk = require("sib-api-v3-sdk");
const { createClient } = require("@supabase/supabase-js");


const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const defaultClient = SibApiV3Sdk.ApiClient.instance;

defaultClient.authentications["api-key"].apiKey =
  process.env.BREVO_API_KEY;

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const sendMachineStopMail = async ({
  userId,
  machineName,
}) => {
  try {
    // ✅ Get user from Supabase Auth
    const { data, error } = await supabase.auth.admin.getUserById(userId);

    if (error || !data?.user) {
      console.error(" User fetch failed:", error);
      return;
    }

    const user = data.user;

    const toEmail = user.email;
    const userName =
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      "User";
     
    // ✅ Send email
    await apiInstance.sendTransacEmail({
      sender: {
        email: "vermaaashu331@gmail.com",
        name: "Hexawash",
      },

      to: [
        {
          email: toEmail,
          name: userName,
        },
      ],

      subject: `Machine Stopped - ${machineName}`,

      htmlContent: `
        <h2>Machine Alert</h2>

        <p>Hello ${userName},</p>

        <p>Your machine <b>${machineName}</b> has stopped.</p>

        <p>Your wash cycle is completed</p>
      `,
    });

    console.log("Mail sent to:", toEmail);
  } catch (err) {
    console.error("Brevo mail error:", err);
  }
};

module.exports = sendMachineStopMail;