require('dotenv').config(); // 👈 force load .env variables here

console.log('Using Brevo SMTP with:', process.env.BREVO_USER, process.env.BREVO_KEY ? '✅ Key loaded' : '❌ Missing key');

const nodemailer = require('nodemailer');


let transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  auth: {
    user: process.env.BREVO_USER,
    pass: process.env.BREVO_KEY
  }
});

function getTransporter() {
  return transporter;
}

module.exports = { getTransporter };
