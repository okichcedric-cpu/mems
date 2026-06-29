import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const TIERS: Record<string, { label: string; amount: number }> = {
  small: { label: "Small", amount: 99 },
  medium: { label: "Medium", amount: 179 },
  big: { label: "Big", amount: 299 },
};

const PESAPAL_BASE =
  Deno.env.get("PESAPAL_ENV") === "sandbox"
    ? "https://cybqa.pesapal.com/pesapalv3"
    : "https://pay.pesapal.com/v3";

async function getPesapalToken(): Promise<string> {
  const res = await fetch(`${PESAPAL_BASE}/api/Auth/RequestToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      consumer_key: Deno.env.get("PESAPAL_CONSUMER_KEY"),
      consumer_secret: Deno.env.get("PESAPAL_CONSUMER_SECRET"),
    }),
  });
  const data = await res.json();
  return data.token;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-KE", {
    day: "numeric", month: "long", year: "numeric",
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const now = new Date();
    const threeDaysFromNow = new Date(now);
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

    // Find active subscriptions expiring within 3 days
    // that haven't had a reminder sent yet
    const { data: expiring, error } = await supabase
      .from("subscriptions")
      .select("user_id, tier, current_period_end, amount")
      .in("status", ["active", "cancelled"])
      .eq("renewal_reminder_sent", false)
      .lte("current_period_end", threeDaysFromNow.toISOString())
      .gte("current_period_end", now.toISOString());

    if (error) throw new Error(error.message);
    if (!expiring || expiring.length === 0) {
      console.log("No subscriptions due for renewal reminders");
      return new Response(
        JSON.stringify({ sent: 0 }),
        { status: 200, headers: corsHeaders },
      );
    }

    console.log(`Found ${expiring.length} subscriptions due for renewal reminders`);

    const token = await getPesapalToken();
    let sent = 0;

    for (const sub of expiring) {
      try {
        // Get user email from auth
        const { data: { user } } = await supabase.auth.admin.getUserById(sub.user_id);
        if (!user?.email) continue;

        const tierConfig = TIERS[sub.tier];
        if (!tierConfig) continue;

        // Generate a fresh payment link for renewal
        const merchantReference =
          `MEMS-${sub.tier.toUpperCase()}-${sub.user_id.replace(/-/g, "").slice(0, 8)}-${Date.now()}`;

        const callbackUrl = `${Deno.env.get("SUPABASE_URL")?.replace("supabase.co/", "")}mems-app.com/subscription-callback`;

        // Register IPN
        const ipnRes = await fetch(`${PESAPAL_BASE}/api/URLSetup/RegisterIPN`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/pesapal-webhook`,
            ipn_notification_type: "GET",
          }),
        });
        const ipnData = await ipnRes.json();

        // Create Pesapal order for renewal
        const orderRes = await fetch(
          `${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              id: merchantReference,
              currency: "KES",
              amount: tierConfig.amount,
              description: `Mems ${tierConfig.label} — Monthly renewal`,
              callback_url: "https://www.mems-app.com/subscription-callback",
              notification_id: ipnData.ipn_id,
              billing_address: {
                email_address: user.email,
                first_name: "Mems",
                last_name: "User",
              },
            }),
          },
        );
        const orderData = await orderRes.json();

        if (!orderData.redirect_url) {
          console.error(`Failed to create renewal link for ${user.email}`);
          continue;
        }

        // Update DB with new merchant reference for this renewal
        await supabase
          .from("subscriptions")
          .update({
            pesapal_merchant_reference: merchantReference,
            renewal_reminder_sent: true,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", sub.user_id);

        // Send renewal reminder email via Resend
        const emailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
          },
          body: JSON.stringify({
            from: "Mems <noreply@mems-app.com>",
            reply_to: "contact@mems-app.com",
            to: [user.email],
            subject: `Your Mems ${tierConfig.label} plan renews on ${formatDate(sub.current_period_end)}`,
            text: `
Hi,

Your Mems ${tierConfig.label} subscription expires on ${formatDate(sub.current_period_end)}.

To keep your collections and photos safe, renew your plan:

Renew now → ${orderData.redirect_url}

Plan: ${tierConfig.label} Album
Amount: KES ${tierConfig.amount}/month

If you choose not to renew, your account will move to the free plan (3 collections, 10 photos each). Your existing photos will remain safe.

— The Mems Team
            `.trim(),
            html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;max-width:560px;width:100%;">
        <tr>
          <td style="background:#111;padding:28px 32px;text-align:center;">
            <p style="margin:0;font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px;">Mems</p>
            <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.6);font-style:italic;">Your life's best moments, all in one place.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111;">⏰ Time to renew</p>
            <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:24px;">
              Your <strong>${tierConfig.label} Album</strong> subscription expires on <strong>${formatDate(sub.current_period_end)}</strong>.<br/>
              Renew now to keep all your collections and photos safe.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border:1px solid #eee;border-radius:12px;margin-bottom:24px;">
              <tr><td style="padding:20px;">
                <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Your plan</p>
                <p style="margin:0;font-size:20px;font-weight:800;color:#111;">${tierConfig.label} Album — KES ${tierConfig.amount}/month</p>
              </td></tr>
            </table>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#111;border-radius:12px;">
                  <a href="${orderData.redirect_url}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#fff;text-decoration:none;">
                    Renew my subscription →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:24px 0 0;font-size:13px;color:#999;line-height:20px;">
              If you choose not to renew, your account will move to the free plan after your period ends. Your photos stay safe.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9f9f9;padding:20px 32px;border-top:1px solid #eee;">
            <p style="margin:0;font-size:12px;color:#bbb;line-height:18px;text-align:center;">
              You're receiving this because you have a Mems subscription.<br/>
              <a href="https://www.mems-app.com" style="color:#999;">mems-app.com</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
            `,
          }),
        });

        if (emailRes.ok) {
          sent++;
          console.log(`Renewal reminder sent to ${user.email} for tier ${sub.tier}`);
        } else {
          const emailErr = await emailRes.json();
          console.error(`Failed to send email to ${user.email}:`, JSON.stringify(emailErr));
        }
      } catch (err: any) {
        console.error(`Error processing renewal for user ${sub.user_id}:`, err.message);
      }
    }

    return new Response(
      JSON.stringify({ sent, total: expiring.length }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    console.error("send-renewal-reminders error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: corsHeaders,
    });
  }
});