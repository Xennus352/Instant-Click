jest.mock("better-auth", () => ({ betterAuth: jest.fn(() => ({ api: { getSession: jest.fn() } })) }));
jest.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: jest.fn(() => ({})) }));
jest.mock("better-auth/next-js", () => ({ toNextJsHandler: jest.fn(() => ({ GET: async () => Response.json({}), POST: async () => Response.json({}) })) }));
jest.mock("@/lib/prisma", () => ({ prisma: {} }));

describe("authentication runtime configuration", () => {
  const names = ["AUTH_SECRET", "AUTH_EMAIL_FROM", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    jest.resetModules();
    for (const name of names) delete process.env[name];
  });

  afterAll(() => {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("imports auth modules at build time without runtime secrets, then rejects auth requests", async () => {
    const { getAuth, AuthConfigurationError } = await import("../../src/lib/auth");
    expect(() => getAuth()).toThrow(AuthConfigurationError);
    const route = await import("../../src/app/api/auth/[...all]/route");
    const response = await route.GET(new Request("http://localhost/api/auth/session"));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("AUTH_CONFIGURATION_UNAVAILABLE");
  });

  it("returns an explicit unavailable response before creating an unverified account", async () => {
    const route = await import("../../src/app/api/auth/[...all]/route");
    const response = await route.POST(new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "User", email: "user@example.test", password: "a-strong-password-123" }),
    }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("AUTH_EMAIL_UNAVAILABLE");
  });

  it("imports the email module without SMTP configuration but rejects email delivery", async () => {
    const email = await import("../../src/lib/auth-email");
    expect(email.isAuthEmailConfigured()).toBe(false);
    await expect(email.sendAuthEmail({ to: "user@example.test", subject: "verify", text: "x", html: "x" }))
      .rejects.toThrow("AUTH_EMAIL_UNAVAILABLE");
  });
});
