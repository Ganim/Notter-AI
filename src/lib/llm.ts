import type { AgentProfile } from "@/types";

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  thought: string;
  command?: string;
  status?: 'DONE' | 'ERROR';
}

const SYSTEM_TEMPLATE = `
[YOUR ROLE]
You are a highly capable autonomous developer agent in the Notter-AI system.
Your goal is to fulfill the user's task perfectly and independently.

[YOUR CAPABILITIES]
You can execute terminal commands on the user's machine (Windows Environment) to navigate, read files, edit files, and build projects.
The system will run the command you provide and return the raw output (stdout/stderr) in the next message.
Wait for the system to provide the output of your command before proceeding. 

[JSON OUTPUT FORMAT EXACTLY]
When you need to run a command, you MUST output valid JSON like this:
{
  "thought": "I need to check the files in this directory because...",
  "command": "dir"
}

When you have fully completed the task and verified it is working:
{
  "thought": "I have verified all steps are done. The project builds successfully.",
  "status": "DONE"
}

[CRITICAL RULES]
1. YOU MUST OUTPUT A SINGLE VALID JSON BLOCK PER MESSAGE. DO NOT add conversational text outside the JSON.
2. Only ONE command per turn.
3. Keep commands valid for Windows CMD/Powershell. (ex: use 'dir' instead of 'ls' if needed, or 'type' instead of 'cat', etc).
`;

export async function askLLM(profile: AgentProfile, messages: ChatMessage[]): Promise<LLMResponse> {
  const finalMessages = [
    { role: 'system', content: `${profile.systemPrompt}\n\n${SYSTEM_TEMPLATE}` },
    ...messages
  ];

  if (profile.provider === 'ollama') {
    try {
       const res = await fetch("http://localhost:11434/api/chat", {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({
           model: "llama3.2", // fallback
           messages: finalMessages,
           stream: false,
           format: "json",
           options: {
             temperature: 0.2
           }
         })
       });
       
       if (!res.ok) {
         throw new Error(`HTTP error: ${res.status}`);
       }

       const data = await res.json();
       const content = data.message?.content || "{}";
       
       return parseJSON(content);
    } catch(e: any) {
       console.error("LLM API failed", e);
       return { thought: `Connection to ${profile.provider} failed: ${e.message}`, status: "ERROR" };
    }
  }
  
  // TODO: Implement OpenAI/Claude/Gemini later
  return { thought: `Provider ${profile.provider} not fully integrated yet. Please use Ollama.`, status: "ERROR" };
}

function parseJSON(content: string): LLMResponse {
   try {
     const match = content.match(/```json\s*(\{[\s\S]*?\})\s*```/);
     if (match) {
       return JSON.parse(match[1]);
     }
     return JSON.parse(content);
   } catch(e) {
     return { thought: `Failed to parse AI output. Raw response: ${content}`, status: "ERROR" };
   }
}
