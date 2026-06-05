import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const token = authHeader.replace("Bearer ", "");

    // Use anon key to verify the user's JWT
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const userEmail = user.email ?? '';
    const userEmailLower = userEmail.toLowerCase();

    // Use service role to bypass RLS entirely
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Query matching both exact and lowercase email variants
    const { data, error } = await supabase
      .from('shared_collections')
      .select('owner_id, collection_name, owner_email, recipient_email')
      .or(`recipient_email.eq.${userEmail},recipient_email.eq.${userEmailLower},recipient_id.eq.${user.id}`);

    if (error) throw new Error(error.message);

    const collections = (data || []).map((row: any) => ({
      ownerId: row.owner_id,
      ownerEmail: row.owner_email ?? 'Unknown',
      collectionName: row.collection_name,
    }));

    // Deduplicate by ownerId + collectionName in case email variants matched twice
    const seen = new Set<string>();
    const uniqueCollections = collections.filter((c) => {
      const key = `${c.ownerId}-${c.collectionName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Update recipient_id for future lookups if not already set
    if (uniqueCollections.length > 0) {
      await supabase
        .from('shared_collections')
        .update({ recipient_id: user.id })
        .or(`recipient_email.eq.${userEmail},recipient_email.eq.${userEmailLower}`)
        .is('recipient_id', null);
    }

    return new Response(
      JSON.stringify({ collections: uniqueCollections }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
});