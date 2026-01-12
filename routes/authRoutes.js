const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");

// Endpoint: POST /auth/request-otp
// Body: { "phone": "08123456789" }
router.post("/request-otp", authController.requestOTP);

// Endpoint: POST /auth/register
// Body: { "phone": "...", "otp_code": "...", "full_name": "...", "password": "..." }
router.post("/register", authController.registerWithOTP);

module.exports = router;
