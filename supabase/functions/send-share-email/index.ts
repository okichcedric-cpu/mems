import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { recipientEmail, ownerEmail, collectionName, appUrl } = await req.json();
    console.log('Sending email to:', recipientEmail, 'from:', ownerEmail);

    if (!recipientEmail || !ownerEmail || !collectionName) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) {
      console.error('RESEND_API_KEY not set');
      return new Response(
        JSON.stringify({ error: "Email service not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Mems <contact@mems-app.com>", // ← use Resend's test address until domain verified
        to: recipientEmail,
        reply_to: ownerEmail,
        subject: `${ownerEmail} shared a collection with you on Mems`,
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #111; margin-bottom: 8px;">You have a new shared collection 📸</h2>
            <p style="color: #444; margin-bottom: 24px;">
              <strong>${ownerEmail}</strong> has shared their collection 
              <strong>${collectionName}</strong> with you on Mems.
            </p>
            <a href="${appUrl ?? 'https://yourapp.com'}" style="
              display: inline-block;
              background: #111;
              color: #fff;
              padding: 12px 28px;
              border-radius: 8px;
              text-decoration: none;
              font-weight: 600;
              font-size: 15px;
            ">Open Mems</a>
            <p style="color: #999; font-size: 13px; margin-top: 32px;">
              Log in or sign up with this email address to see the shared collection.
            </p>
          </div>
        `,
      }),
    });

    const data = await res.json();
    console.log('Resend response:', res.status, JSON.stringify(data));

    if (!res.ok) {
      console.error("Resend error:", data);
      return new Response(
        JSON.stringify({ error: data }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, id: data.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Function error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});