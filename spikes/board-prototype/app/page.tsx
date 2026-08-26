import { redirect } from "next/navigation"

// First run opens with zero sessions (R54): the front door is New Chat, not
// a pre-started scenario session.
export default function Home() {
  redirect("/new-chat")
}
