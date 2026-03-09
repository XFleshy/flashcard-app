import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://emxqygvqorwyjwogbgpi.supabase.co";
const SUPABASE_KEY = "sb_publishable_FysnLX7sEeFS5zUU8LGygw_X1ASocA8";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
