import { SupabaseClient } from '@supabase/supabase-js';

// Function to execute Supabase query and delete matching records
export async function deleteMatchingRecords(
  sourceUrl: string,
  supabase: SupabaseClient,
) {
  try {
    const { data, error } = await supabase
      .from('lore')
      .delete()
      .filter('content', 'cs', `{"sourceUrl":"${sourceUrl}"}`);

    if (error) {
      throw error;
    }

    return data;
  } catch (error) {
    console.error('Error deleting records:', error);
    return null;
  }
}
