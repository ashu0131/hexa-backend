const { check, validationResult } = require('express-validator');

// Common handler for all validations
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ msg: errors.array()[0].msg });
  }
  next();
};

// Validate login
exports.validateLogin = [
  check('email').trim().isEmail().normalizeEmail().withMessage('Invalid email address'),
  check('password').trim().notEmpty().withMessage('Password is required'),
  handleValidation
];

// Validate registration
exports.validateRegister = [
  check('username')
  .trim()
  .escape()
  .isLength({ min: 2 }).withMessage('Name is too short'),
  check('email').trim().isEmail().normalizeEmail().withMessage('Invalid email'),
  check('password')
  .trim()
  .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
  .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
  .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
  .matches(/\d/).withMessage('Password must contain at least one number')
  .matches(/[@$!%*?&#^()_\-+=]/).withMessage('Password must contain at least one special character'),
  check('roomNumber').trim().isString().notEmpty().withMessage('Room number is required'),
  handleValidation
];

// Validate forgot password
exports.validateForgotPassword = [
  check('email').trim().isEmail().normalizeEmail().withMessage('Invalid email'),
  handleValidation
];

// Validate reset password
exports.validateResetPassword = [
  check('password')
  .trim()
  .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
  .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
  .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
  .matches(/\d/).withMessage('Password must contain at least one number')
  .matches(/[@$!%*?&#^()_\-+=]/).withMessage('Password must contain at least one special character'),
  handleValidation
];

// Validate resend verification
exports.validateResendVerification = [
  check('email').trim().isEmail().normalizeEmail().withMessage('Invalid email'),
  handleValidation
];
