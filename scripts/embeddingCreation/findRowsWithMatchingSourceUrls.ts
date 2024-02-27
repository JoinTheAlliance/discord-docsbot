import { SupabaseClient } from '@supabase/supabase-js';

// Function to query summarizations table for related records to replace
export async function findMatchingRows(sourceUrl: string, supabase: SupabaseClient) {
    try {
      const { data, error } = await supabase
      .from('summarizations')
      .select()
      .contains('meta_data', { "sourceUrl": sourceUrl });
  
      if (error) {
        throw error;
      }
  
      return data;
    } catch (error) {
      console.error('Error fetching data:', error);
      return null;
    }
}