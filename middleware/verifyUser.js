const supabase = require('../utils/supabaseAdmin');

module.exports = async function verifyUser(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ msg: 'Unauthorized' });

    const token = auth.split(' ')[1];

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({ msg: 'Unauthorized' });
    }

    req.user = data.user; // Supabase user
    next();

  } catch (err) {
    console.error(err);
    res.status(401).json({ msg: 'Unauthorized' });
  }
};