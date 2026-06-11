const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Public AGB route
router.get('/agb', async (req, res) => {
  try {
    const exactStoragePath = 'agb/latest.pdf'; 

    const { data, error } = await supabase.storage
      .from('documents')
      .download(exactStoragePath);

    if (error || !data) {
      console.error("Supabase Storage Error:", error?.message || error);
      return res.status(404).send('AGB file not found in agb/ folder');
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="AGB.pdf"');

    const buffer = Buffer.from(await data.arrayBuffer());
    return res.send(buffer);

  } catch (err) {
    console.error(" Server Error:", err);
    return res.status(500).send('Failed to stream AGB asset');
  }
});

module.exports = router;