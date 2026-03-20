import { useState, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import Editor from "@monaco-editor/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BaseDirectory, readDir, mkdir, readTextFile, writeTextFile, exists, remove } from "@tauri-apps/plugin-fs";
import { useRef } from "react";
import { Plus, Trash2, Pen, Eye, Terminal as TerminalIcon } from "lucide-react";
import { TerminalView, TerminalHandle } from "@/components/TerminalView";
import "./App.css";

function App() {
  const [subjects, setSubjects] = useState<string[]>([]);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);
  const [tasks, setTasks] = useState<string[]>([]);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [taskContent, setTaskContent] = useState<string>("# Anotações da Tarefa");

  // Dialog State
  const [isSubjectDialogOpen, setIsSubjectDialogOpen] = useState(false);
  const [isTaskDialogOpen, setIsTaskDialogOpen] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [deleteSubjectTarget, setDeleteSubjectTarget] = useState<string | null>(null);
  const [deleteTaskTarget, setDeleteTaskTarget] = useState<string | null>(null);

  // Editor Header State
  const [isViewing, setIsViewing] = useState(false);

  const BG_COLORS = [
    { name: "Zinc", value: "bg-zinc-50 dark:bg-zinc-900", hex: "#fafafa", base: "vs" },
    { name: "Taupe", value: "bg-stone-50 dark:bg-stone-900", hex: "#fafaf9", base: "vs" },
    { name: "Mist", value: "bg-sky-50 dark:bg-sky-950", hex: "#f0f9ff", base: "vs" },
    { name: "Mauve", value: "bg-purple-50 dark:bg-purple-950", hex: "#faf5ff", base: "vs" },
    { name: "Olive", value: "bg-lime-50 dark:bg-lime-950", hex: "#f7fee7", base: "vs" },
    { name: "Dark", value: "bg-background", hex: "#09090b", base: "vs-dark" },
  ];

  const [editorBgClass, setEditorBgClass] = useState(BG_COLORS[0].value);
  const [editorTheme, setEditorTheme] = useState(`theme-${BG_COLORS[0].name}`);

  const handleEditorWillMount = (monaco: any) => {
    BG_COLORS.forEach(c => {
      monaco.editor.defineTheme(`theme-${c.name}`, {
        base: c.base as any,
        inherit: true,
        rules: [],
        colors: { "editor.background": c.hex }
      });
    });
  };

  // Consoles State
  const [consoles, setConsoles] = useState<{id: string, name: string}[]>([{ id: "default", name: "Agent Shell" }]);
  const firstTerminalRef = useRef<TerminalHandle>(null);

  const addConsole = () => {
    if (consoles.length >= 4) {
      toast.error("Limite máximo de 4 consoles atingido.");
      return;
    }
    const id = Date.now().toString();
    setConsoles(prev => [...prev, { id, name: `Terminal ${prev.length + 1}` }]);
  };

  const removeConsole = (id: string) => {
    setConsoles(prev => prev.filter(c => c.id !== id));
  };

  // Load subjects on mount
  useEffect(() => {
    async function initFs() {
      try {
        const hasDir = await exists("AgentNotes", { baseDir: BaseDirectory.AppLocalData });
        if (!hasDir) await mkdir("AgentNotes", { baseDir: BaseDirectory.AppLocalData, recursive: true });
        
        const entries = await readDir("AgentNotes", { baseDir: BaseDirectory.AppLocalData });
        const dirs = entries.filter(e => e.isDirectory).map(e => e.name);
        setSubjects(dirs);
      } catch (e) { console.error(e) }
    }
    initFs();
  }, []);

  // Load tasks when subject selected
  useEffect(() => {
    if (!selectedSubject) return;
    async function fetchTasks() {
      try {
        const entries = await readDir(`AgentNotes/${selectedSubject}`, { baseDir: BaseDirectory.AppLocalData });
        const files = entries.filter(e => e.isFile && e.name.endsWith(".md")).map(e => e.name);
        setTasks(files);
      } catch (e) { console.error(e) }
    }
    fetchTasks();
  }, [selectedSubject]);

  // Load task content
  useEffect(() => {
    if (!selectedSubject || !selectedTask) return;
    async function fetchContent() {
      try {
        const content = await readTextFile(`AgentNotes/${selectedSubject}/${selectedTask}`, { baseDir: BaseDirectory.AppLocalData });
        setTaskContent(content);
      } catch (e) { setTaskContent("# Erro ao carregar"); }
    }
    fetchContent();
  }, [selectedTask, selectedSubject]);

  // Save task content
  const handleEditorChange = async (value: string | undefined) => {
    const val = value || "";
    setTaskContent(val);
    if (!selectedSubject || !selectedTask) return;
    try {
      await writeTextFile(`AgentNotes/${selectedSubject}/${selectedTask}`, val, { baseDir: BaseDirectory.AppLocalData });
    } catch (e) { console.error(e); }
  };

  // CRUD Handlers (Dialog callbacks)
  const handleCreateSubjectSubmit = async () => {
    if (!newItemName.trim()) return;
    try {
      await mkdir(`AgentNotes/${newItemName}`, { baseDir: BaseDirectory.AppLocalData, recursive: true });
      setSubjects(prev => [...prev, newItemName]);
      setIsSubjectDialogOpen(false);
      setNewItemName("");
      toast.success("Assunto criado com sucesso!");
    } catch (e: any) { console.error(e); toast.error(`Erro ao criar assunto: ${e}`); }
  };

  const confirmDeleteSubject = async () => {
    if (!deleteSubjectTarget) return;
    try {
      await remove(`AgentNotes/${deleteSubjectTarget}`, { baseDir: BaseDirectory.AppLocalData, recursive: true });
      setSubjects(prev => prev.filter(s => s !== deleteSubjectTarget));
      if (selectedSubject === deleteSubjectTarget) {
        setSelectedSubject(null);
        setSelectedTask(null);
      }
      setDeleteSubjectTarget(null);
      toast.success("Assunto deletado!");
    } catch (err: any) { console.error(err); toast.error(`Erro ao deletar assunto: ${err}`); }
  };

  const handleCreateTaskSubmit = async () => {
    if (!selectedSubject || !newItemName.trim()) return;
    const fileName = newItemName.endsWith(".md") ? newItemName : `${newItemName}.md`;
    try {
      await writeTextFile(`AgentNotes/${selectedSubject}/${fileName}`, "# Nova Anotação\n\nDescreva a tarefa...", { baseDir: BaseDirectory.AppLocalData });
      setTasks(prev => [...prev, fileName]);
      setSelectedTask(fileName);
      setIsTaskDialogOpen(false);
      setNewItemName("");
      toast.success("Tarefa criada!");
    } catch (e: any) { console.error(e); toast.error(`Erro ao criar tarefa: ${e}`); }
  };

  const confirmDeleteTask = async () => {
    if (!deleteTaskTarget) return;
    try {
      await remove(`AgentNotes/${selectedSubject}/${deleteTaskTarget}`, { baseDir: BaseDirectory.AppLocalData });
      setTasks(prev => prev.filter(t => t !== deleteTaskTarget));
      if (selectedTask === deleteTaskTarget) {
        setSelectedTask(null);
        setTaskContent("");
      }
      setDeleteTaskTarget(null);
      toast.success("Tarefa removida!");
    } catch (err: any) { console.error(err); toast.error(`Erro ao deletar tarefa: ${err}`); }
  };

  const triggerSubjectDialog = () => { setNewItemName(""); setIsSubjectDialogOpen(true); };
  const triggerTaskDialog = () => { setNewItemName(""); setIsTaskDialogOpen(true); };

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col overflow-hidden">
      <Toaster />
      <Tabs defaultValue="planner" className="w-full h-full flex flex-col">
        {/* HEADER / NAVIGATION */}
        <div className="h-12 shrink-0 border-b flex items-center px-4 bg-muted/40">
          <TabsList>
            <TabsTrigger value="planner">Planner</TabsTrigger>
            <TabsTrigger value="agent">Agent Builder</TabsTrigger>
            <TabsTrigger value="console">Console Map</TabsTrigger>
          </TabsList>
        </div>

        {/* TAB CONTENTS */}
        <div className="flex-1 overflow-hidden">
          <TabsContent value="planner" className="h-full m-0 p-0 border-none outline-none data-[state=active]:flex">
            {/* @ts-expect-error shadcn type mismatch */}
            <ResizablePanelGroup direction="horizontal" className="w-full h-full rounded-none">
              <ResizablePanel defaultSize={20} minSize={15} className="bg-muted/50">
                <div className="flex flex-col h-full uppercase font-semibold text-xs text-muted-foreground">
                  <div className="p-3 border-b border-border/50 flex items-center justify-between">
                    <span>Assuntos</span>
                    <button onClick={triggerSubjectDialog} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors" title="Criar Assunto">
                      <Plus size={14} />
                    </button>
                  </div>
                  <ScrollArea className="flex-1">
                    <div className="p-2 space-y-1">
                      {subjects.map(s => (
                        <div 
                          key={s} 
                          onClick={() => { setSelectedSubject(s); setSelectedTask(null); }}
                          className={`group flex items-center justify-between p-2 text-sm rounded-md cursor-pointer ${selectedSubject === s ? "bg-accent text-accent-foreground" : "hover:bg-muted font-normal"}`}
                        >
                          <span className="truncate">{s}</span>
                          <button onClick={(e) => { e.stopPropagation(); setDeleteSubjectTarget(s); }} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                      {subjects.length === 0 && <div className="text-xs p-2 normal-case text-muted-foreground">Nenhum assunto criado.</div>}
                    </div>
                  </ScrollArea>
                </div>
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize={25} minSize={20} className="bg-muted/20">
                <div className="flex flex-col h-full font-semibold text-xs text-muted-foreground">
                  <div className="p-3 border-b border-border/50 uppercase flex items-center justify-between">
                    <span>Tarefas</span>
                    <button 
                      onClick={triggerTaskDialog} 
                      disabled={!selectedSubject}
                      className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50" 
                      title="Criar Tarefa"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <ScrollArea className="flex-1">
                    <div className="p-2 space-y-2">
                       {tasks.map(t => (
                         <div 
                           key={t}
                           onClick={() => setSelectedTask(t)} 
                           className={`group flex items-center justify-between p-2 text-sm rounded-md cursor-pointer ${selectedTask === t ? "bg-accent text-accent-foreground" : "hover:bg-muted text-foreground"}`}
                         >
                           <div className="flex items-center space-x-2 truncate">
                             <input type="checkbox" className="rounded border-gray-400 bg-transparent pointer-events-none" />
                             <span className="truncate font-normal">{t.replace(".md", "")}</span>
                           </div>
                           <button onClick={(e) => { e.stopPropagation(); setDeleteTaskTarget(t); }} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity">
                             <Trash2 size={14} />
                           </button>
                         </div>
                       ))}
                       {tasks.length === 0 && selectedSubject && <div className="text-xs p-2 normal-case font-normal text-muted-foreground">Aperte '+' para criar a primeira tarefa.</div>}
                       {!selectedSubject && <div className="text-xs p-2 normal-case font-normal text-muted-foreground">Selecione um Assunto primeiro.</div>}
                    </div>
                  </ScrollArea>
                </div>
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize={55}>
                <div className="flex flex-col h-full">
              <ResizablePanel defaultSize={55} className="flex flex-col bg-background">
                {selectedTask ? (
                  <>
                    <div className="h-12 border-b border-border flex items-center justify-between px-4 sticky top-0 bg-background z-10 shrink-0">
                      <span className="font-semibold text-sm text-foreground">
                        Anotações sobre <span className="text-primary">{selectedTask.replace(".md", "")}</span>
                      </span>
                      <div className="flex items-center space-x-4">
                        <div className="flex bg-muted rounded-md p-1 border border-border">
                          {BG_COLORS.map(c => (
                            <button
                              key={c.name}
                              title={c.name}
                              onClick={() => { setEditorBgClass(c.value); setEditorTheme(`theme-${c.name}`); }}
                              className={`w-4 h-4 rounded-full mx-1 border cursor-pointer hover:scale-110 transition-transform ${c.value.split(" ")[0]} ${editorBgClass === c.value ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : "border-border"}`}
                            />
                          ))}
                        </div>
                        <div className="flex bg-muted rounded-md p-1">
                          <button 
                            onClick={() => setIsViewing(false)} 
                            className={`flex items-center space-x-1 px-3 py-1 rounded-sm text-xs font-medium transition-colors ${!isViewing ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                          >
                            <Pen size={12} /><span>Editar</span>
                          </button>
                          <button 
                            onClick={() => setIsViewing(true)} 
                            className={`flex items-center space-x-1 px-3 py-1 rounded-sm text-xs font-medium transition-colors ${isViewing ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                          >
                            <Eye size={12} /><span>Visualizar</span>
                          </button>
                        </div>
                      </div>
                    </div>
                    
                    <div className={`flex-1 w-full relative overflow-y-auto transition-colors duration-300 ${editorBgClass}`}>
                      {!isViewing ? (
                        <Editor
                          height="100%"
                          defaultLanguage="markdown"
                          theme={editorTheme}
                          beforeMount={handleEditorWillMount}
                          value={taskContent}
                          onChange={handleEditorChange}
                          options={{ minimap: { enabled: false }, wordWrap: "on", fontSize: 13, padding: { top: 16 } }}
                          className="absolute inset-0"
                        />
                      ) : (
                        <div className="p-8 max-w-3xl mx-auto prose prose-sm dark:prose-invert max-w-none">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {taskContent}
                          </ReactMarkdown>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                    Selecione ou crie uma tarefa para visualizar o editor.
                  </div>
                )}
              </ResizablePanel>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </TabsContent>

          <TabsContent value="agent" className="h-full m-0 p-0 border-none outline-none data-[state=active]:flex">
            <div className="flex-1 flex flex-col items-center justify-center bg-background p-6 overflow-y-auto">
              <div className="max-w-xl w-full space-y-6">
                <div>
                  <h2 className="text-2xl font-bold tracking-tight">Agent Configuration</h2>
                  <p className="text-muted-foreground text-sm">Configure your Autonomous AI Agent settings.</p>
                </div>
                
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium leading-none">AI Provider</label>
                    <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background disabled:cursor-not-allowed disabled:opacity-50">
                      <option>OpenAI (GPT-4)</option>
                      <option>Anthropic (Claude 3)</option>
                      <option>Google (Gemini 1.5 Pro)</option>
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium leading-none">API Key</label>
                    <input 
                      type="password"
                      placeholder="sk-..." 
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium leading-none">System Instruction (Prompt base)</label>
                    <textarea 
                      className="flex min-h-[150px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
                      defaultValue={"You are an expert software engineer.\nReview the tasks from the Planner tab and execute them using the provided CLI tools. Mark tasks as [x] when completed."}
                    />
                  </div>

                  <div className="flex gap-2">
                    <button className="bg-primary hover:bg-primary/90 text-primary-foreground h-10 px-4 py-2 rounded-md font-medium text-sm w-full transition-colors">
                      Save configuration
                    </button>
                    <button 
                      onClick={() => {
                        if (firstTerminalRef.current) {
                          firstTerminalRef.current.writeln(`\r\n\x1b[35m[AGENT]\x1b[0m Launching Agent on task: ${selectedTask || 'No task selected'}`);
                          firstTerminalRef.current.writeln(`\x1b[35m[AGENT]\x1b[0m Executing command mapping...`);
                        }
                        toast.info(selectedTask ? `Agente disparado para: ${selectedTask}` : "Selecione uma tarefa no Planner primeiro!");
                      }}
                      className="bg-secondary hover:bg-secondary/80 text-secondary-foreground h-10 px-4 py-2 rounded-md font-medium text-sm w-full transition-colors"
                    >
                      Launch Agent
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="console" className="h-full m-0 p-0 border-none outline-none data-[state=active]:flex flex-col">
            <div className="h-12 border-b flex items-center justify-between px-4 bg-muted/20 shrink-0">
               <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Console Map</span>
               <button 
                  onClick={addConsole} 
                  disabled={consoles.length >= 4}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground px-3 py-1.5 rounded-sm flex items-center text-xs space-x-1 font-medium transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
               >
                  <Plus size={14} /><span>Novo Console</span>
               </button>
            </div>
            
            <div className="relative bg-background overflow-hidden w-full" style={{ height: 'calc(100% - 3rem)' }}>
              <div className="absolute inset-4 flex flex-wrap gap-4 content-start">
                {consoles.map((c, idx) => {
                  const isTwoCols = consoles.length > 1;
                  const isTwoRows = consoles.length > 2;
                  const w = isTwoCols ? 'calc(50% - 0.5rem)' : '100%';
                  const h = isTwoRows ? 'calc(50% - 0.5rem)' : '100%';

                  return (
                    <div key={c.id} style={{ width: w, height: h }} className="flex flex-col">
                      <TerminalView 
                         id={c.id} 
                         name={c.name} 
                         onClose={removeConsole} 
                         ref={idx === 0 ? firstTerminalRef : undefined}
                      />
                    </div>
                  );
                })}
                {consoles.length === 0 && (
                  <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground space-y-4">
                    <TerminalIcon size={48} className="opacity-20" />
                    <p className="text-sm font-medium">Nenhum console em execução.</p>
                    <button onClick={addConsole} className="text-primary hover:underline text-sm font-medium">Abrir novo terminal interativo</button>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
        </div>
      </Tabs>

      {/* DIALOGS */}
      <Dialog open={isSubjectDialogOpen} onOpenChange={setIsSubjectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo Assunto</DialogTitle>
            <DialogDescription>Crie uma nova pasta de anotações.</DialogDescription>
          </DialogHeader>
          <input 
            autoFocus
            type="text" 
            placeholder="Ex: Funcionalidade X" 
            value={newItemName} 
            onChange={e => setNewItemName(e.target.value)} 
            onKeyDown={e => e.key === "Enter" && handleCreateSubjectSubmit()}
            className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <DialogFooter>
            <button onClick={handleCreateSubjectSubmit} className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md font-medium text-sm transition-colors">Criar</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isTaskDialogOpen} onOpenChange={setIsTaskDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova Tarefa em {selectedSubject}</DialogTitle>
            <DialogDescription>Crie um novo arquivo markdown.</DialogDescription>
          </DialogHeader>
          <input 
            autoFocus
            type="text" 
            placeholder="Ex: pesquisar-bug.md" 
            value={newItemName} 
            onChange={e => setNewItemName(e.target.value)} 
            onKeyDown={e => e.key === "Enter" && handleCreateTaskSubmit()}
            className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <DialogFooter>
            <button onClick={handleCreateTaskSubmit} className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md font-medium text-sm transition-colors">Criar</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteSubjectTarget} onOpenChange={(open) => !open && setDeleteSubjectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deletar Assunto</DialogTitle>
            <DialogDescription>Isso irá apagar permanentemente '{deleteSubjectTarget}' e todas as suas tarefas.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button onClick={() => setDeleteSubjectTarget(null)} className="px-4 py-2 rounded-md font-medium text-sm hover:bg-muted transition-colors">Cancelar</button>
            <button onClick={confirmDeleteSubject} className="bg-rose-500 hover:bg-rose-600 text-white px-4 py-2 rounded-md font-medium text-sm transition-colors">Deletar</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTaskTarget} onOpenChange={(open) => !open && setDeleteTaskTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deletar Tarefa</DialogTitle>
            <DialogDescription>Remover irreversivelmente a tarefa '{deleteTaskTarget}'?</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button onClick={() => setDeleteTaskTarget(null)} className="px-4 py-2 rounded-md font-medium text-sm hover:bg-muted transition-colors">Cancelar</button>
            <button onClick={confirmDeleteTask} className="bg-rose-500 hover:bg-rose-600 text-white px-4 py-2 rounded-md font-medium text-sm transition-colors">Deletar</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

export default App;
