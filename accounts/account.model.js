


const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const schema = new Schema({
    email: { type: String, unique: true, required: true },
    passwordHash: { type: String, required: true },
    title: { type: String },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    gender: { type: String, required: true },
    type: { type: String, required: true },
    
    // Location fields for Tinder-style distance calculation
    currentCity: { type: String, default: '' },
    location: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point'
        },
        coordinates: {
            type: [Number], // [longitude, latitude]
            default: [0, 0]
        }
    },
    locationUpdatedAt: { type: Date, default: null },
    locationSharingEnabled: { type: Boolean, default: true },

    // Presence/Online Status Fields
    onlineStatus: { 
        type: String, 
        enum: ['online', 'inactive', 'offline'], 
        default: 'offline' 
    },
    lastSeen: { type: Date, default: null },
    lastActivity: { type: Date, default: null },

    // New Fields
    nickname: { type: String },
    DOB: { type: Date },
    phone: { type: String },
    origin: { type: String },
    bio: { type: String, maxlength: 700 },
    interests: [{ type: String }],
    photos: [String],
    languages: [{ type: String }],
    fieldOfStudy: { type: String },
    degreeField: { type: String, default: null },   // User-editable "Degree / Field of Study" (SNL & alumni edit profile)
    graduationYear: { type: String },
    industry: { type: String },
    currentRole: { type: String },
    linkedIn: { type: String },
    funFact: { type: String },
    rship: { type: String },
    // Alumni-specific
    schoolGraduatedFrom: { type: String, default: null },
    // SchoolNotListed-specific (explicitly entered school name)
    schoolName: { type: String, default: null },
    welcomeEmailSent: { type: Boolean, default: false },

    // Recovery email (personal email for login after graduation)
    recoveryEmail: { type: String, default: null },
    recoveryEmailVerified: { type: Boolean, default: false },
    recoveryOtp: { type: String, default: null },
    recoveryOtpExpires: { type: Date, default: null },
    recoveryEmailDismissedAt: { type: Date, default: null },

    role: { type: String, required: true, default: 'User' },
    
    // Push notifications
    expoPushToken: { type: String, default: null },

    // Onboarding coach marks tracking
    onboardingCompleted: [{ type: String }],



    verificationToken: String,
    verificationTokenExpires: Date,   // ✅ ADD THIS

    verified: Date,
    resetToken: {
        token: String,
        expires: Date
    },
    passwordReset: Date,
    created: { type: Date, default: Date.now },
    updated: Date
});

schema.virtual('isVerified').get(function () {
    return !!(this.verified || this.passwordReset);
});

schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: function (doc, ret) {
        delete ret._id;
        delete ret.passwordHash;
    }
});

// Create 2dsphere index for geospatial queries (proximity search)
schema.index({ 'location': '2dsphere' });

module.exports = mongoose.model('Account', schema);
