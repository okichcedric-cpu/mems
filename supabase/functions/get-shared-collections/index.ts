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

    // Two parameterized queries run in parallel instead of one .or() that
    // spanned two different columns (recipient_email / recipient_id).
    // .in()/.eq() bind values directly rather than interpolating them into
    // a filter string, so a value can never alter the filter's structure —
    // same reasoning generate-upload-url already applies to this exact
    // lookup. Results are unioned below, then de-duplicated same as before.
    const [byEmailResult, byUserIdResult] = await Promise.all([
      supabase
        .from('shared_collections')
        .select('owner_id, collection_name, owner_email, recipient_email')
        .in('recipient_email', [userEmail, userEmailLower]),
      supabase
        .from('shared_collections')
        .select('owner_id, collection_name, owner_email, recipient_email')
        .eq('recipient_id', user.id),
    ]);

    if (byEmailResult.error) throw new Error(byEmailResult.error.message);
    if (byUserIdResult.error) throw new Error(byUserIdResult.error.message);

    const data = [...(byEmailResult.data ?? []), ...(byUserIdResult.data ?? [])];

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
        .in('recipient_email', [userEmail, userEmailLower])
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