import { SupabaseClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import { findMatchingRows } from './findRowsWithMatchingSourceUrls';
import { deleteMatchingRecords } from './deleteRowsWithMatchingSourceUrls';
import { insertSummarization } from './vectorizeAndInsertNewData';

export async function generateEmbeddings(documents: Array<string>, sourceUrl: string, supabase: SupabaseClient, openai: OpenAI) {
    // Finds the records related to the sourceUrl url
    const relatedRecords = await findMatchingRows(sourceUrl, supabase);
    console.log("Related Records: ", relatedRecords)

    // If we find records, process which to delete then delete them from database
    if (relatedRecords) {
        const deletedRecords = await deleteMatchingRecords(sourceUrl, supabase);
        console.log("Deleted Records: ", deletedRecords)
    }

    // Loops over each section of the new document
    for (const document of documents) {
      await insertSummarization(document, sourceUrl, supabase, openai)
    }
}