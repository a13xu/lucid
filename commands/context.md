Get the minimal relevant context for the current task using Lucid's TF-IDF retrieval.

Steps:
1. Identify the current task from the conversation (what are we working on right now?)
2. Call `mcp__lucid__get_context` with:
   - `query`: one concise sentence describing the current task
   - `maxTokens`: 4000 (default)
   - `topK`: 10
3. Review the returned file skeletons
4. Highlight the 3 most relevant files and explain WHY they're relevant
5. If the context seems incomplete, suggest calling `mcp__lucid__sync_project` first to re-index

Then use the returned context to continue with the task without asking the user to specify which files to look at.
