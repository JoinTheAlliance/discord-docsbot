import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Initializes Supabase for API interaction.
 * @param {string} supabaseUrl - The Supabase URL
 * @param {string} supabaseServiceApiKey - The Supabase Service API Key
 * @returns {SupabaseClient} - SupabaseClient object for database API calls.
 */
export function initializeSupabase(
    supabaseUrl: string | undefined,
    supabaseServiceApiKey: string | undefined
  ): SupabaseClient {
    const supabase = createClient(
      supabaseUrl!,
      supabaseServiceApiKey!,
      {
        auth: { persistSession: false },
      }
    );
  
    return supabase;
  }