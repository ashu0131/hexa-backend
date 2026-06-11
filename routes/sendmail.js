const express = require("express");
const router = express.Router();

const sendMachineStopMail = require("../utils/sendMachineStopMail");

// Example route
router.post("/machine-stop", async (req, res) => {
  try {
    const { userId, machineName } = req.body;
    
    if (!userId || !machineName) {
      return res.status(400).json({
        error: "userId and machineName are required",
      });
    }

    // ✅ Send mail
    await sendMachineStopMail({
      userId,
      machineName,
    });

    return res.json({
      success: true,
      message: "Machine stop mail sent",
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

module.exports = router;