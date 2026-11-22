import { z } from "zod";

const email = z.string().trim().max(254).email().transform((value) => value.toLowerCase());
const password = z.string().min(12).max(128);
const callbackURL = z.string().url().optional();

export const signUpSchema = z.object({ name: z.string().trim().min(1).max(100), email, password, callbackURL }).passthrough();
export const signInSchema = z.object({ email, password: z.string().min(1).max(128), callbackURL, rememberMe: z.boolean().optional() }).passthrough();
export const forgotPasswordSchema = z.object({ email, redirectTo: callbackURL }).passthrough();
export const resetPasswordSchema = z.object({ token: z.string().min(1).max(512), newPassword: password }).passthrough();
export const sendVerificationSchema = z.object({ email, callbackURL }).passthrough();
export const socialSignInSchema = z.object({
  provider: z.enum(["google", "github"]),
  callbackURL,
  errorCallbackURL: callbackURL,
  newUserCallbackURL: callbackURL,
}).passthrough();

export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
