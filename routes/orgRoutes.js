const express = require("express");
const {
    createOrganisation,
    getOrganisations,
    getOrgByUser,
    updateOrganisation,
    deleteOrganisation,
    joinOrganisation,
    getUserOrganizations,
    getCurrentOrgData,
    removeOrganizationMember
} = require("../controllers/orgController");
const { authMiddleware, requireOrg } = require("../middleware/orgMiddleware");

const router = express.Router();

// ✅ Just pass controller directly
router.post("/create-org", createOrganisation);
router.get("/get-org", getOrganisations)
router.get("/member/:user_id", getOrganisations)
router.put("/update/:id",updateOrganisation)
router.delete("/delete/:id",deleteOrganisation)
router.post("/join-org", authMiddleware, joinOrganisation);
router.get("/my-organizations", authMiddleware, getUserOrganizations);
router.get("/current", authMiddleware, requireOrg, getCurrentOrgData);
router.delete(
  "/members/:userId",
  authMiddleware,
  requireOrg,
  removeOrganizationMember
);

module.exports = router;