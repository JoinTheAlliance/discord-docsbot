import { SupabaseClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import { findMatchingRows } from './findRowsWithMatchingSourceUrls';
import { deleteMatchingRecords } from './deleteRowsWithMatchingSourceUrls';
import { insertLore } from './vectorizeAndInsertNewData';

export async function generateEmbeddings(
  documents: Array<string>,
  sourceUrl: string,
  supabase: SupabaseClient,
  openai: OpenAI,
) {
  // Finds the records related to the sourceUrl url
  const relatedRecords = await findMatchingRows(sourceUrl, supabase);
  //console.log("Related Records: ", relatedRecords)

  // If we find records, process which to delete then delete them from database
  if (relatedRecords) {
    await deleteMatchingRecords(sourceUrl, supabase);
  }

  //console.log("Document length: ", documents.length)
  // Loops over each section of the new document
  for (const document of documents) {
    //console.log("Document inserting is2: ", document)
    await insertLore(document, sourceUrl, supabase, openai);
  }
}
