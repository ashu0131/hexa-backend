const { createClient } = require("@supabase/supabase-js");
const bcrypt = require("bcrypt");

require("dotenv").config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


// create organisation api for owner...
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const createOrganisation = async (req, res) => {
  try {
    const { org_unique_id, name, password,  } = req.body;

    if (!org_unique_id || !name || !password) {
      return res.status(400).json({
        success: false,
        message: "org_unique_id, name and password are required",
      });
    }

    // 1. Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 2. Create Stripe Connect account (EXPRESS)
    const account = await stripe.accounts.create({
      type: "express",
   
    
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });

    // 3. Create onboarding link (IMPORTANT: use FRONTEND URLs, not backend)
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
       refresh_url: `${ process.env.FRONTEND_URL}/reauth`,
       return_url: `${process.env.FRONTEND_URL}/dashboard`, 
      type: "account_onboarding",
    });

    // 4. Save org in DB
    const { data, error } = await supabase
      .from("organizations")
      .insert([
        {
          org_unique_id,
          name,
          password: hashedPassword,
          stripe_account_id: account.id,
         
        },
      ])
      .select()
      .single();

    if (error) throw error;

    // 5. Response
    return res.status(201).json({
      success: true,
      message: "Organisation created successfully",
      data,
      stripe: {
        account_id: account.id,
        onboarding_url: accountLink.url,
      },
    });

  } catch (err) {
    console.error("Stripe/Server Error:", err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
// get all the organizations for owner...
const getOrganisations = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("*");

    if (error) {
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// 🔥 GET ORGANISATION FOR USER (IMPORTANT FOR STRIPE)
const getOrgByUser = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("organisation_members")
      .select("organization_id")
      .eq("user_id", req.params.user_id)
      .single();

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.json(data);
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
};
// update name unique_id or password api 
const updateOrganisation = async (req, res) => {
  try {
    const { id } = req.params;
    const { org_unique_id, name, password } = req.body;

    let updatedData = {};

    if (org_unique_id) updatedData.org_unique_id = org_unique_id;
    if (name) updatedData.name = name;

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      updatedData.password = hashedPassword;
    }

    // ❗ check if at least one field is provided
    if (Object.keys(updatedData).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields provided to update",
      });
    }

    const { data, error } = await supabase
      .from("organizations")
      .update(updatedData)
      .eq("id", id)
      .select();

    if (error) {
      console.error("Update Error:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Organisation updated successfully",
      data,
    });

  } catch (err) {
    console.error("Server Error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};



// delete organisation with id   
const deleteOrganisation = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "ID is required",
      });
    }

    // 1. Pehle check karein ki Org exist karti hai (UX ke liye behtar hai)
    const { data: existingOrg, error: fetchError } = await supabase
      .from("organizations")
      .select("id")
      .eq("id", id)
      .single();

    if (fetchError || !existingOrg) {
      return res.status(404).json({
        success: false,
        message: "Organisation not found",
      });
    }

    // 2. Delete Operation
    const { error } = await supabase
      .from("organizations")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("Delete Error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to delete from database: " + error.message,
      });
    }

    // 3. Success Response
    return res.status(200).json({
      success: true,
      message: `Organisation ${id} has been permanently removed.`,
    });

  } catch (err) {
    console.error("Server Error:", err);
    return res.status(500).json({
      success: false,
      message: "An internal server error occurred",
    });
  }
};


// join organisation via unique id and password OR verified QR Code token
const joinOrganisation = async (req, res) => {
  try {
    const { org_unique_id, password, room_number, isQrScan } = req.body;
    const user_id = req.user?.id;

    if (!user_id) {
      return res.status(401).json({ message: "Unauthorized user session" });
    }

    // 🚨 FIX A: Clear strict check logic bounds
if (!org_unique_id || !room_number || (isQrScan !== true && !password)) {
  return res.status(400).json({
    message: !room_number 
      ? "Room number field is mandatory to complete profile registration" 
      : "org_unique_id and password fields are required",
  });
} 

    // 1️⃣ Find organization profile on Supabase backend
    const { data: org, error: orgError } = await supabase
      .from("organizations")
      .select("*")
      .eq("org_unique_id", org_unique_id)
      .single();

    if (orgError || !org) {
      return res.status(404).json({
        message: "Organisation not found in ecosystem registry",
      });
    }

    // 🔐 FIX B: Strict check constraint bypass rules layer
    if (isQrScan !== true) {
      const isMatch = await bcrypt.compare(password, org.password);
      if (!isMatch) {
        return res.status(401).json({ 
          message: "Invalid organization secure password" 
        });
      }
    }

    // 3️⃣ Verify if connection mapping node already exists
    const { data: existing } = await supabase
      .from("organization_members")
      .select("*")
      .eq("organization_id", org.id)
      .eq("user_id", user_id)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        message: "You have already joined this organization workspace",
      });
    }

    // 4️⃣ Insert user member record node
    const { data, error } = await supabase
      .from("organization_members")
      .insert([
        {
          organization_id: org.id,
          user_id: user_id,
          role: "user",
          room_number:room_number
        },
      ])
      .select();

    if (error) {
      return res.status(500).json({
        message: "Failed to create organization connection link matrix",
        error: error.message,
      });
    }

    return res.status(200).json({
      message: "Successfully joined organisation matrix workspace structure!",
      data,
    });

  } catch (err) {
    return res.status(500).json({
      message: "Server internal configuration breakdown error",
      error: err.message,
    });
  }
};

// remove user from organizastion memeber table 
const removeOrganizationMember = async (req, res) => {
  try {
    const adminUserId = req.user.id;
    const orgId = req.orgId;
    const { userId } = req.params;

    // Check current user's role in this organization
    const { data: adminMember, error: adminError } = await supabase
      .from("organization_members")
      .select("role")
      .eq("user_id", adminUserId)
      .eq("organization_id", orgId)
      .single();

    if (adminError || !adminMember) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    if (
      adminMember.role !== "admin" &&
      adminMember.role !== "super_admin"
    ) {
      return res.status(403).json({
        success: false,
        message: "Only admin can remove members",
      });
    }

    // Optional: prevent admin from removing themselves
    if (userId === adminUserId) {
      return res.status(400).json({
        success: false,
        message: "You cannot remove yourself",
      });
    }

    // Verify target user belongs to current organization
    const { data: member, error: memberError } = await supabase
      .from("organization_members")
      .select("id")
      .eq("user_id", userId)
      .eq("organization_id", orgId)
      .single();

    if (memberError || !member) {
      return res.status(404).json({
        success: false,
        message: "Member not found in this organization",
      });
    }

    // Remove member from organization
    const { error: deleteError } = await supabase
      .from("organization_members")
      .delete()
      .eq("user_id", userId)
      .eq("organization_id", orgId);

    if (deleteError) {
      throw deleteError;
    }

    return res.status(200).json({
      success: true,
      message: "Member removed successfully",
    });

  } catch (err) {
    console.error("Remove member error:", err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// fecth all the orgainzastion the user will join with password
const getUserOrganizations = async (req, res) => {
  try {
    const userId = req.user.id; // from auth middleware

    // 🔥 join organization_members with organizations
    const { data, error } = await supabase
      .from("organization_members")
      .select(`
  organization_id,
  organizations (
    id,
    name
  )
`)
      .eq("user_id", userId);

    if (error) {
      throw error;
    }

    return res.status(200).json({
      message: "User organizations fetched successfully",
      data,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Failed to fetch organizations",
      error: err.message,
    });
  }
};

const getCurrentOrgData = async (req, res) => {
  try {
    const userId = req.user.id;
    const orgId = req.orgId;

    const { data, error } = await supabase
      .from("organization_members")
      .select("balance, role")
      .eq("user_id", userId)
      .eq("organization_id", orgId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        message: "Organization membership not found",
      });
    }

    return res.status(200).json({
      message: "Current org data fetched",
      data,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Failed to fetch org data",
    });
  }
};

module.exports = { 
    createOrganisation,
    getOrganisations,
    updateOrganisation,
    deleteOrganisation,
    joinOrganisation,
    getUserOrganizations,
    getCurrentOrgData ,
    removeOrganizationMember
};





 
