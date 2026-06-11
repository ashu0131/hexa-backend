const supabase = require('../utils/supabaseAdmin');

async function verifyAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ msg: 'Unauthorized' });

    const token = auth.split(' ')[1];

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({ msg: 'Unauthorized' });
    }

    const userId = data.user.id;

    // Check role in profiles table
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single();

    if (profileError || !profile || profile.role !== 'admin') {
      return res.status(403).json({ msg: 'Forbidden – Admins only' });
    }

    req.user = {
      id: userId,
      email: data.user.email,
      role: profile.role
    };

    next();

  } catch (err) {
    console.error(err);
    res.status(401).json({ msg: 'Unauthorized' });
  }
}

module.exports = { verifyAdmin };