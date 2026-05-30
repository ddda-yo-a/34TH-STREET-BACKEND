const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const SchoolRequest = require('./schoolRequest.model');
const Account = require('../accounts/account.model');
const sendEmail = require('../_helpers/send-email');
const config = require('../config.js');

function hash(password) {
  return bcrypt.hashSync(password, 10);
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

module.exports = {
  sendOtp,
  resendOtp,
  verifyOtp,
  submitRequest,
  getAll,
  getById,
  approve,
  deny,
  getStats,
};

/**
 * Send OTP to school email for verification
 */
async function sendOtp({ schoolEmail, firstName }) {
  const email = schoolEmail.toLowerCase().trim();

  // Check if there's already an approved request or existing account
  const existingAccount = await Account.findOne({ email });
  if (existingAccount && existingAccount.verified) {
    throw 'An account with this email already exists. Please login.';
  }

  const otp = generateOTP();
  const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Store OTP temporarily — either update existing pending request or create placeholder
  let request = await SchoolRequest.findOne({ schoolEmail: email, status: 'pending' });
  if (request) {
    request.otpToken = otp;
    request.otpExpires = otpExpires;
    request.otpAttempts = 0; // Reset attempts on resend
    await request.save();
  } else {
    // Create a minimal placeholder that will be fully populated on submit
    request = new SchoolRequest({
      firstName: firstName || 'Pending',
      lastName: 'Pending',
      gender: 'Male',
      phone: 'pending',
      schoolEmail: email,
      program: 'pending',
      linkedIn: 'https://linkedin.com/in/pending',
      passwordHash: 'pending',
      otpToken: otp,
      otpExpires: otpExpires,
      otpAttempts: 0,
      schoolEmailVerified: false,
      createdAt: new Date(),
    });
    await request.save();
  }

  // Send OTP email with improved template
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #581845 0%, #8B2E6C 100%); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center; }
        .header h2 { margin: 0; font-size: 24px; }
        .header p { margin: 8px 0 0 0; color: #ffb60a; font-size: 14px; }
        .content { background: white; padding: 30px; border: 1px solid #e0e0e0; }
        .otp-box { background: linear-gradient(135deg, #f5edf8 0%, #f0e6f0 100%); padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0; }
        .otp-code { font-size: 36px; font-weight: bold; letter-spacing: 6px; color: #581845; font-family: 'Courier New', monospace; }
        .footer { background: #f5f5f5; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; color: #666; }
        p { line-height: 1.6; color: #333; }
        .warning { color: #666; font-size: 13px; margin: 15px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>34th Street</h2>
          <p>Email Verification</p>
        </div>
        <div class="content">
          <p>Hi${firstName ? ` ${firstName}` : ''},</p>
          
          <p>Thanks for requesting access to 34th Street. Your verification code is:</p>
          
          <div class="otp-box">
            <div class="otp-code">${otp}</div>
          </div>
          
          <p style="text-align: center; margin: 20px 0;">Or if your app didn't show it, enter this code manually:</p>
          
          <div class="warning">
            ⏱️ This code expires in 10 minutes<br/>
            🔒 Never share this code with anyone<br/>
            ❓ If you didn't request this, please ignore this email
          </div>
        </div>
        <div class="footer">
          <p>© 2024 34th Street. All rights reserved.</p>
          <p style="margin: 5px 0 0 0;">Need help? <a href="https://34thstreet.net/app-support/" style="color: #581845; text-decoration: none;">Visit our support center</a></p>
        </div>
      </div>
    </body>
    </html>
  `;

  // Send email with comprehensive error handling
  try {
    console.log(`📧 [SchoolRequest] Sending OTP to ${email}...`);
    await sendEmail({
      to: email,
      subject: 'Your 34th Street Verification Code',
      html,
    });
    console.log(`✅ [SchoolRequest] OTP email sent successfully to ${email}`);
  } catch (err) {
    console.error(`❌ [SchoolRequest] Failed to send OTP email:`, err.message);
    // Still return success - user can retry or request new OTP
    console.log(`ℹ️  [SchoolRequest] Returning partial success - user can resend OTP`);
  }

  return { message: 'OTP sent to your school email. Check inbox/spam folder.', requestId: request.id };
}

/**
 * Verify OTP for school email
 */
async function verifyOtp({ schoolEmail, otp }) {
  const email = schoolEmail.toLowerCase().trim();
  const now = new Date();

  const request = await SchoolRequest.findOne({
    schoolEmail: email,
    otpToken: otp,
    otpExpires: { $gt: now },
  });

  if (!request) {
    throw 'Invalid or expired verification code.';
  }

  request.schoolEmailVerified = true;
  request.otpToken = undefined;
  request.otpExpires = undefined;
  await request.save();

  return { message: 'Email verified successfully', requestId: request.id, verified: true };
}

/**
 * Resend OTP to school email (rate-limited)
 */
async function resendOtp({ schoolEmail, firstName }) {
  const email = schoolEmail.toLowerCase().trim();
  const request = await SchoolRequest.findOne({ schoolEmail: email, status: 'pending' });

  if (!request) {
    throw 'No pending verification request found for this email.';
  }

  if (request.schoolEmailVerified) {
    throw 'Email already verified. Please proceed to submit your full application.';
  }

  // Rate limiting: minimum 30 seconds between OTP requests
  const lastOtpTime = request.lastOtpRequestedAt || new Date(0);
  const timeSinceLastOtp = Date.now() - lastOtpTime.getTime();
  const MIN_TIME_BETWEEN_OTP = 30 * 1000;

  if (timeSinceLastOtp < MIN_TIME_BETWEEN_OTP) {
    const retryAfter = Math.ceil((MIN_TIME_BETWEEN_OTP - timeSinceLastOtp) / 1000);
    throw `Please wait ${retryAfter} seconds before requesting another code.`;
  }

  // Generate new OTP
  const otp = generateOTP();
  const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
  
  request.otpToken = otp;
  request.otpExpires = otpExpires;
  request.lastOtpRequestedAt = new Date();
  request.otpAttempts = (request.otpAttempts || 0) + 1;
  await request.save();

  // Send OTP email
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #581845 0%, #8B2E6C 100%); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center; }
        .header h2 { margin: 0; font-size: 24px; }
        .header p { margin: 8px 0 0 0; color: #ffb60a; font-size: 14px; }
        .content { background: white; padding: 30px; border: 1px solid #e0e0e0; }
        .otp-box { background: linear-gradient(135deg, #f5edf8 0%, #f0e6f0 100%); padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0; }
        .otp-code { font-size: 36px; font-weight: bold; letter-spacing: 6px; color: #581845; font-family: 'Courier New', monospace; }
        .footer { background: #f5f5f5; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; color: #666; }
        p { line-height: 1.6; color: #333; }
        .warning { color: #666; font-size: 13px; margin: 15px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>34th Street</h2>
          <p>Email Verification (Resent)</p>
        </div>
        <div class="content">
          <p>Hi${firstName ? ` ${firstName}` : ''},</p>
          
          <p>Here's your new verification code:</p>
          
          <div class="otp-box">
            <div class="otp-code">${otp}</div>
          </div>
          
          <p style="text-align: center; margin: 20px 0;">Or enter this code manually in your app:</p>
          
          <div class="warning">
            ⏱️ This code expires in 10 minutes<br/>
            🔒 Never share this code with anyone<br/>
            ❓ If you didn't request this, please ignore this email
          </div>
        </div>
        <div class="footer">
          <p>© 2024 34th Street. All rights reserved.</p>
          <p style="margin: 5px 0 0 0;">Need help? <a href="https://34thstreet.net/app-support/" style="color: #581845; text-decoration: none;">Visit our support center</a></p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    console.log(`📧 [SchoolRequest] Resending OTP to ${email}...`);
    await sendEmail({
      to: email,
      subject: 'Your 34th Street Verification Code (Resent)',
      html,
    });
    console.log(`✅ [SchoolRequest] OTP resent successfully to ${email}`);
  } catch (err) {
    console.error(`❌ [SchoolRequest] Failed to resend OTP:`, err.message);
  }

  return { message: 'New verification code sent. Check your inbox/spam folder.', requestId: request.id };
}

/**
 * Submit full "School Not Listed" request (after OTP verification)
 */
async function submitRequest(params) {
  const email = params.schoolEmail.toLowerCase().trim();

  // Find the verified placeholder or create new
  let request = await SchoolRequest.findOne({
    schoolEmail: email,
    schoolEmailVerified: true,
    status: 'pending',
  });

  if (!request) {
    throw 'Please verify your school email first before submitting.';
  }

  // Check for duplicate account
  const existingAccount = await Account.findOne({ email });
  if (existingAccount && existingAccount.verified) {
    throw 'An account with this school email already exists.';
  }

  // Update the request with full data
  request.firstName = params.firstName;
  request.lastName = params.lastName;
  request.gender = params.gender;
  request.phone = params.phone;
  request.schoolName = params.schoolName || null;
  request.schoolEmail = email;
  request.program = params.program;
  request.graduationYear = params.graduationYear || null;
  request.linkedIn = params.linkedIn;
  request.passwordHash = hash(params.password);
  request.status = 'pending';

  await request.save();

  // Send submission confirmation email
  await sendSubmissionConfirmationEmail(request);

  return {
    message: 'Your application has been submitted successfully. Our team will review your profile within 3-5 working days.',
    requestId: request.id,
  };
}

/**
 * Get all school requests (admin)
 */
async function getAll({ status, page = 1, limit = 20, search } = {}) {
  const query = {};
  // Only show fully submitted requests (not OTP placeholders)
  query.firstName = { $ne: 'Pending' };

  if (status && status !== 'all') {
    query.status = status;
  }
  if (search) {
    const regex = new RegExp(search, 'i');
    query.$or = [
      { firstName: regex },
      { lastName: regex },
      { schoolEmail: regex },
      { program: regex },
    ];
  }

  const skip = (page - 1) * limit;
  const [requests, total] = await Promise.all([
    SchoolRequest.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('reviewedBy', 'firstName lastName email')
      .lean(),
    SchoolRequest.countDocuments(query),
  ]);

  return {
    requests,
    total,
    page,
    pages: Math.ceil(total / limit),
  };
}

/**
 * Get single request by ID (admin)
 */
async function getById(id) {
  const request = await SchoolRequest.findById(id)
    .populate('reviewedBy', 'firstName lastName email');
  if (!request) throw 'Request not found';
  return request;
}

/**
 * Get stats counts
 */
async function getStats() {
  const [pending, approved, denied, total] = await Promise.all([
    SchoolRequest.countDocuments({ status: 'pending', firstName: { $ne: 'Pending' } }),
    SchoolRequest.countDocuments({ status: 'approved' }),
    SchoolRequest.countDocuments({ status: 'denied' }),
    SchoolRequest.countDocuments({ firstName: { $ne: 'Pending' } }),
  ]);
  return { pending, approved, denied, total };
}

/**
 * Approve a school request — create account + send approval email
 */
async function approve(id, adminId) {
  const request = await SchoolRequest.findById(id);
  if (!request) throw 'Request not found';
  if (request.status !== 'pending') throw 'Request has already been processed';

  // Create the user account using the school email as primary
  const existingAccount = await Account.findOne({ email: request.schoolEmail });
  if (existingAccount && existingAccount.verified) {
    throw 'An account with this school email already exists.';
  }

  let account = existingAccount;
  if (!account) {
    account = new Account({
      email: request.schoolEmail,
      passwordHash: request.passwordHash,
      firstName: request.firstName,
      lastName: request.lastName,
      gender: request.gender,
      phone: request.phone,
      type: 'Student',
      role: 'User',
      fieldOfStudy: request.program || null,     // ✅ full program string e.g. "Master of Business Administration (MBA)"
      graduationYear: request.graduationYear || null, // ✅ expected graduation year
      schoolName: request.schoolName || null,    // ✅ explicit school name entered during registration
      linkedIn: request.linkedIn || null,        // ✅ pre-fill from application
      verified: new Date(), // Pre-verified by admin
    });
  } else {
    // Update existing unverified account
    account.passwordHash = request.passwordHash;
    account.firstName = request.firstName;
    account.lastName = request.lastName;
    account.gender = request.gender;
    account.phone = request.phone;
    account.fieldOfStudy = request.program || account.fieldOfStudy || null;     // ✅ populate
    account.graduationYear = request.graduationYear || account.graduationYear || null; // ✅ populate
    account.schoolName = request.schoolName || account.schoolName || null;       // ✅ populate
    account.linkedIn = request.linkedIn || account.linkedIn || null;             // ✅ populate
    account.verified = new Date();
  }

  await account.save();

  // Update request status
  request.status = 'approved';
  request.reviewedAt = new Date();
  request.reviewedBy = adminId;
  request.accountId = account._id;
  await request.save();

  // Send approval email to school email
  await sendApprovalEmail(request);

  return { message: 'Request approved. User account created and notification sent.', account: account.id };
}

/**
 * Deny a school request
 */
async function deny(id, adminId, reason) {
  const request = await SchoolRequest.findById(id);
  if (!request) throw 'Request not found';
  if (request.status !== 'pending') throw 'Request has already been processed';

  request.status = 'denied';
  request.reviewedAt = new Date();
  request.reviewedBy = adminId;
  request.denialReason = reason || null;
  await request.save();

  // Send denial email
  await sendDenialEmail(request);

  return { message: 'Request denied. Notification sent to applicant.' };
}

// ─── Email Templates ──────────────────────────────────────────

async function sendSubmissionConfirmationEmail(request) {
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #222; max-width: 600px; margin: 0 auto;">
      <div style="background: #581845; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
        <h2 style="color: #fff; margin: 0;">34th Street</h2>
      </div>
      <div style="padding: 24px; background: #fff; border: 1px solid #eee; border-top: none; border-radius: 0 0 12px 12px;">
        <h3 style="color: #581845;">Your 34th Street profile is being reviewed</h3>
        <p>Hi ${request.firstName},</p>
        <p>Thank you for your interest in joining 34th Street. We've received your application and our team will review your profile within <strong>3–5 working days</strong>.</p>
        <p>Once your profile has been verified, you'll receive an email with instructions to activate your account.</p>
        <p>We look forward to welcoming you to the community.</p>
        <p style="margin-top: 24px;">Warm regards,<br/><strong>The 34th Street Team</strong></p>
        <hr style="margin: 16px 0; border: none; border-top: 1px solid #eee;" />
        <p style="font-size: 13px; color: #888;">Need help? Visit <a href="https://34thstreet.net/app-support/" style="color: #581845;">34thstreet.net/app-support</a></p>
      </div>
    </div>
  `;

  await sendEmail({
    to: request.schoolEmail,
    subject: 'Your 34th Street profile is being reviewed',
    html,
  });
}

async function sendApprovalEmail(request) {
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #222; max-width: 600px; margin: 0 auto;">
      <div style="background: #581845; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
        <h2 style="color: #fff; margin: 0;">34th Street</h2>
        <p style="color: #ffb60a; margin: 4px 0 0;">You're in!</p>
      </div>
      <div style="padding: 24px; background: #fff; border: 1px solid #eee; border-top: none; border-radius: 0 0 12px 12px;">
        <h3 style="color: #581845;">You're in — welcome to 34th Street</h3>
        <p>Hi ${request.firstName},</p>
        <p>Great news — your profile has been verified and you've been approved to join 34th Street.</p>
        <p>Your account has been activated. You can now log in to the 34th Street app using your school email:</p>
        <div style="text-align: center; margin: 20px 0; padding: 16px; background: #f5edf8; border-radius: 8px;">
          <p style="margin: 0; font-size: 14px; color: #666;">Login Email</p>
          <p style="margin: 4px 0 0; font-size: 18px; font-weight: bold; color: #581845;">${request.schoolEmail}</p>
        </div>
        <p>Once logged in, you'll be taken to complete your profile and join the community.</p>
        <p style="margin-top: 24px;">Welcome to 34th Street.<br/><strong>The 34th Street Team</strong></p>
        <hr style="margin: 16px 0; border: none; border-top: 1px solid #eee;" />
        <p style="font-size: 13px; color: #888;">Need help? Visit <a href="https://34thstreet.net/app-support/" style="color: #581845;">34thstreet.net/app-support</a></p>
      </div>
    </div>
  `;

  await sendEmail({
    to: request.schoolEmail,
    subject: "You're in — welcome to 34th Street",
    html,
  });
}

async function sendDenialEmail(request) {
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #222; max-width: 600px; margin: 0 auto;">
      <div style="background: #581845; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
        <h2 style="color: #fff; margin: 0;">34th Street</h2>
      </div>
      <div style="padding: 24px; background: #fff; border: 1px solid #eee; border-top: none; border-radius: 0 0 12px 12px;">
        <h3 style="color: #581845;">Update on your 34th Street application</h3>
        <p>Hi ${request.firstName},</p>
        <p>Thank you for applying to join 34th Street. After reviewing your profile, we were unable to verify your identity at this time.</p>
        <p>This is usually because one of the following:</p>
        <ul style="color: #555; padding-left: 20px;">
          <li>Your current school or employer is not publicly confirmed on your LinkedIn profile</li>
          <li>Your LinkedIn profile could not be found or matched to the details you submitted</li>
          <li>Your profile is not listed on your institution's or company's public people directory</li>
        </ul>
        <p><strong>To strengthen your application before reapplying:</strong></p>
        <ul style="color: #555; padding-left: 20px;">
          <li>Ensure your current position or enrollment is listed and visible on your LinkedIn profile</li>
          <li>Add your institution or employer to the Experience or Education section</li>
          <li>If your company has a public "Our People" or team page, make sure your name appears there</li>
          <li>Set your LinkedIn profile visibility to public</li>
        </ul>
        <p>Once your profile is updated, you're welcome to reapply. We'd love to have you as part of the community.</p>
        <p>If you believe this was an error, please reach out to us at <a href="mailto:info@34thstreet.net" style="color: #581845;">info@34thstreet.net</a></p>
        <p style="margin-top: 24px;">The 34th Street Team</p>
        <hr style="margin: 16px 0; border: none; border-top: 1px solid #eee;" />
        <p style="font-size: 13px; color: #888;">Need help? Visit <a href="https://34thstreet.net/app-support/" style="color: #581845;">34thstreet.net/app-support</a></p>
      </div>
    </div>
  `;

  await sendEmail({
    to: request.schoolEmail,
    subject: 'Update on your 34th Street application',
    html,
  });
}
