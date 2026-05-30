const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const alumniRequestSchema = new Schema({
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  gender: { type: String, required: true, enum: ['Male', 'Female', 'Non-binary'] },
  phone: { type: String, required: true, trim: true },
  personalEmail: { type: String, required: true, trim: true, lowercase: true },
  workEmail: { type: String, trim: true, lowercase: true, default: null },
  schoolGraduatedFrom: { type: String, required: true, trim: true },
  degreeHeld: { type: String, required: true, trim: true },
  graduationYear: { type: String, default: null },
  linkedIn: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true },

  // OTP verification for personal email
  personalEmailVerified: { type: Boolean, default: false },
  otpToken: { type: String, default: null },
  otpExpires: { type: Date, default: null },

  // Admin review
  status: {
    type: String,
    enum: ['pending', 'approved', 'denied'],
    default: 'pending',
  },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'Account', default: null },
  denialReason: { type: String, default: null },

  // Link to created account (set after approval)
  accountId: { type: Schema.Types.ObjectId, ref: 'Account', default: null },
}, {
  timestamps: true,
});

alumniRequestSchema.index({ personalEmail: 1, status: 1 });

alumniRequestSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    delete ret._id;
    delete ret.passwordHash;
    delete ret.otpToken;
    delete ret.otpExpires;
  },
});

module.exports = mongoose.model('AlumniRequest', alumniRequestSchema);
