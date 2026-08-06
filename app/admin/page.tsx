/**
 * /admin — permanently moved.
 * The dashboard now lives at the home route. This stub keeps old bookmarks
 * and shared links working.
 */

import { redirect } from "next/navigation";

export default function AdminRedirect() {
  redirect("/");
}
