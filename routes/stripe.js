const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

router.post("/create-checkout-session", async (req, res) => {
  try {
    const { user_id, amount, org_id } = req.body;

    // ✅ VALIDATION
    if (!user_id || !amount || !org_id) {
      console.log(" INVALID PAYLOAD:", req.body);
      return res.status(400).json({ msg: "Invalid payload" });
    }

    const parsedAmount = Number(amount);

    if (isNaN(parsedAmount)) {
      return res.status(400).json({ msg: "Amount must be a number" });
    }

    // if (parsedAmount < 10) {
    //   return res.status(400).json({ msg: "Minimum recharge is €10" });
    // }

    // ✅ GET ORGANISATION
    const { data: org, error } = await supabase
      .from("organizations")
      .select("stripe_secret_key, name")
      .eq("id", org_id)
      .single();

    if (error || !org) {
      console.log("ORG ERROR:", error);
      return res.status(400).json({ msg: "Org not found" });
    }

    // if (!org.stripe_account_id) {
    //   return res.status(400).json({ msg: "Org not connected to Stripe" });
    // }

    if (!org.stripe_secret_key) {
      return res.status(400).json({ msg: "Stripe not configured for org" });
    }

    const stripe = new Stripe(org.stripe_secret_key);

    // 🔥 NEW: CHECK STRIPE ACCOUNT STATUS
    // const account = await stripe.accounts.retrieve(org.stripe_account_id);

    // console.log("ACCOUNT STATUS:", {
    //   details_submitted: account.details_submitted,
    //   charges_enabled: account.charges_enabled,
    // });

    // if (!account.details_submitted || !account.charges_enabled) {
    //   const accountLink = await stripe.accountLinks.create({
    //     account: org.stripe_account_id,
    //      refresh_url: `${
    //       process.env.FRONTEND_URL || "http://localhost:5173"
    //     }/reauth`,
    //     return_url: `${
    //       process.env.FRONTEND_URL || "http://localhost:5173"
    //     }/dashboard`,
    //     type: "account_onboarding",
    //   });

    //   return res.status(400).json({
    //     msg: "Complete Stripe onboarding first",
    //     onboarding_url: accountLink.url,
    //      requirements: account.requirements,
    //   });
    // }

    const origin =
      req.headers.origin || process.env.FRONTEND_URL || "http://localhost:5173";

    const { data: user, error: userError } = await supabase
      .from("profiles") // or your users table
      .select("email")
      .eq("id", user_id)
      .single();

    if (userError || !user) {
      return res.status(400).json({ msg: "User not found" });
    }

    // ✅ CREATE CHECKOUT SESSION
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card", "klarna", "revolut_pay", "paypal"],

        customer_email: user.email,

        line_items: [
          {
            price_data: {
              currency: "eur",
              product_data: {
                name: `${org.name} Laundry Recharge`,
              },

              unit_amount: Math.round(parsedAmount * 100),
            },
            quantity: 1,
          },
        ],
        allow_promotion_codes: true,

        metadata: {
          user_id,
          org_id,
          original_amount: String(parsedAmount),
        },

        success_url: `${origin}/recharge-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/dashboard`,
      },
      // {
      //   stripeAccount: org.stripe_account_id,
      // },
    );

    return res.json({ url: session.url });
  } catch (err) {
    console.error("🔥 FULL STRIPE ERROR:", err);
    console.error("🔥 RAW:", err.raw);

    return res.status(500).json({
      msg: err.raw?.message || "Stripe error",
    });
  }
});

module.exports = router;
