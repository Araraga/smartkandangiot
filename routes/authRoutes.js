const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");

// --- CCTV 1: Cek saat server nyala ---
console.log("✅ File authRoutes.js BERHASIL dimuat!");

router.post(
  "/request-otp",
  (req, res, next) => {
    // --- CCTV 2: Cek saat ada request masuk ---
    console.log("🔔 Ada yang mengetuk pintu /request-otp!");
    next();
  },
  authController.requestOTP
);

router.post("/register", authController.registerWithOTP);

module.exports = router;
