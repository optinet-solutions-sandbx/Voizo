"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  type Node,
  type Edge,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Campaign, Group } from "@/lib/campaignData";

// ── Types ──────────────────────────────────────────────────────────────────

type StepType = "step" | "schedule_meeting" | "sms" | "action" | "call_transfer" | "end_call";

interface ScriptStep {
  id: number;
  type: StepType;
  text: string;
  // schedule_meeting
  meetingService?: string;
  // sms
  smsTemplate?: string;
  // call_transfer
  transferPhone?: string;
  transferCallerId?: string;
  warmTransfer?: boolean;
}

interface ScriptNodeData extends Record<string, unknown> {
  label: string;
  isStart?: boolean;
  onClick?: () => void;
  selected?: boolean;
}

interface Scenario {
  id: number;
  question: string;
  steps: ScriptStep[];
}

interface Props {
  onClose: () => void;
  onSave: (campaign: Campaign) => void;
  nextId: number;
  availableGroups: Group[];
  initialName?: string;
}

type Tab = "Script" | "Scenarios" | "Workflow";

// ── Initial flow data ──────────────────────────────────────────────────────

const initialNodes: Node<ScriptNodeData>[] = [
  {
    id: "start",
    type: "startNode",
    position: { x: 0, y: 0 },
    data: { label: "Start", isStart: true },
    draggable: false,
    selectable: false,
  },
  {
    id: "intro",
    type: "scriptNode",
    position: { x: -50, y: 80 },
    data: { label: "Intro Script", selected: false },
  },
];

const initialEdges: Edge[] = [
  { id: "e-start-intro", source: "start", target: "intro", style: { stroke: "#D1D5DB", strokeWidth: 1.5 } },
];

// ── Workflow flow data ─────────────────────────────────────────────────────

interface WfNodeData extends Record<string, unknown> {
  title?: string; icon?: string; description?: string; actionLabel?: string;
}

const initialWorkflowNodes: Node<WfNodeData>[] = [
  { id: "wf-triggers",  type: "wfSimpleNode",  position: { x: 0,    y: 0 }, data: { title: "Triggers",        icon: "bolt",  description: "Select events that add or archive contacts.",      actionLabel: "Add" } },
  { id: "wf-precall",   type: "wfSimpleNode",  position: { x: 308,  y: 0 }, data: { title: "Pre-Call Actions",icon: "share", description: "Run actions before the call is dialed.",          actionLabel: "Add" } },
  { id: "wf-center",    type: "wfCenterNode",  position: { x: 616,  y: 0 }, data: {} },
  { id: "wf-success",   type: "wfSimpleNode",  position: { x: 952,  y: 0 }, data: { title: "Success Criteria",icon: "thumb", description: "Define the possible outcomes of a conversation.", actionLabel: "Generate" } },
  { id: "wf-postcall",  type: "wfSimpleNode",  position: { x: 1260, y: 0 }, data: { title: "Post-Call Actions",icon: "share", description: "Execute actions based on call outcomes.",        actionLabel: "Add" } },
];

const initialWorkflowEdges: Edge[] = [
  { id: "wf-e1", source: "wf-triggers", target: "wf-precall",  type: "straight", style: { stroke: "#CBD5E1", strokeWidth: 1, strokeDasharray: "7 7" } },
  { id: "wf-e2", source: "wf-precall",  target: "wf-center",   type: "straight", style: { stroke: "#CBD5E1", strokeWidth: 1, strokeDasharray: "7 7" } },
  { id: "wf-e3", source: "wf-center",   target: "wf-success",  type: "straight", style: { stroke: "#CBD5E1", strokeWidth: 1, strokeDasharray: "7 7" } },
  { id: "wf-e4", source: "wf-success",  target: "wf-postcall", type: "straight", style: { stroke: "#CBD5E1", strokeWidth: 1, strokeDasharray: "7 7" } },
];

// ── Custom nodes ──────────────────────────────────────────────────────────

function StartNode() {
  return (
    <div className="flex items-center gap-1.5 bg-[#E0E7FF] text-[#4F46E5] rounded-full px-4 py-1.5 text-sm font-medium shadow-sm pointer-events-none">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path fillRule="evenodd" clipRule="evenodd" d="M4.5 12C4.5 11.586 4.836 11.25 5.25 11.25H16.189L12.22 7.28C11.927 6.987 11.927 6.513 12.22 6.22C12.513 5.927 12.987 5.927 13.28 6.22L18.53 11.47C18.823 11.763 18.823 12.237 18.53 12.53L13.28 17.78C12.987 18.073 12.513 18.073 12.22 17.78C11.927 17.487 11.927 17.013 12.22 16.72L16.189 12.75H5.25C4.836 12.75 4.5 12.414 4.5 12Z" fill="currentColor" />
      </svg>
      Start
    </div>
  );
}

function ScriptNode({ data }: { data: ScriptNodeData }) {
  return (
    <div
      className={`bg-white rounded-xl border-2 shadow-sm px-10 py-4 font-semibold text-gray-900 text-sm cursor-pointer transition-all hover:shadow-md min-w-[190px] text-center
        ${data.selected ? "border-[#4F46E5] shadow-[0_0_0_4px_rgba(79,70,229,0.12)]" : "border-gray-200 hover:border-gray-300"}`}
      onClick={data.onClick as (() => void) | undefined}
    >
      {data.label as string}
    </div>
  );
}

const nodeTypes = { startNode: StartNode, scriptNode: ScriptNode, wfSimpleNode: WfSimpleNode, wfCenterNode: WfCenterNode };

// ── Workflow node components ───────────────────────────────────────────────

function WfSimpleNode({ data }: { data: WfNodeData }) {
  const isBolt  = data.icon === "bolt";
  const isThumb = data.icon === "thumb";

  const iconEl = isBolt ? (
    <span className="w-6 h-6 rounded-lg bg-amber-50 border border-amber-200 flex items-center justify-center shrink-0">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="text-amber-500"><path d="M13 2L4.093 12.688H12L11 22L19.907 11.312H12L13 2Z" fill="currentColor"/></svg>
    </span>
  ) : isThumb ? (
    <span className="w-6 h-6 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center shrink-0">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="text-blue-500"><path d="M2 20h2a1 1 0 001-1V9a1 1 0 00-1-1H2v12zm16.5-12H13V6c0-1.66-1.34-3-3-3h-1v2c0 .55.45 1 1 1h.5C11.33 6 12 6.67 12 7.5V8h-2.5c-.83 0-1.5.67-1.5 1.5v9c0 .83.67 1.5 1.5 1.5h8a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0018.5 8z" fill="currentColor"/></svg>
    </span>
  ) : (
    <span className="w-6 h-6 rounded-lg bg-purple-50 border border-purple-200 flex items-center justify-center shrink-0">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="text-purple-500"><path fillRule="evenodd" clipRule="evenodd" d="M21.5 4.5C21.5 5.605 20.605 6.5 19.5 6.5C18.395 6.5 17.5 5.605 17.5 4.5C17.5 3.395 18.395 2.5 19.5 2.5C20.605 2.5 21.5 3.395 21.5 4.5ZM4.5 15.5C6.433 15.5 8 13.933 8 12C8 10.067 6.433 8.5 4.5 8.5C2.567 8.5 1 10.067 1 12C1 13.933 2.567 15.5 4.5 15.5ZM19.5 21.5C20.605 21.5 21.5 20.605 21.5 19.5C21.5 18.395 20.605 17.5 19.5 17.5C18.395 17.5 17.5 18.395 17.5 19.5C17.5 20.605 18.395 21.5 19.5 21.5Z" fill="currentColor"/></svg>
    </span>
  );

  return (
    <div className="bg-white rounded-2xl outline outline-1 outline-offset-[-1px] outline-[#E4E7E5] hover:outline-[#3655E8] transition-all w-[258px] shadow-sm">
      <Handle type="target" position={Position.Left}  style={{ opacity: 0, pointerEvents: "none" }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: "none" }} />
      {/* Title row */}
      <div className="h-11 flex items-center gap-2.5 px-4 border-b border-[#F1F3F2]">
        {iconEl}
        <span className="text-sm font-semibold text-[#181B19]">{data.title as string}</span>
      </div>
      {/* Body */}
      <div className="p-4">
        <p className="text-xs text-[#707B73] mb-4 leading-relaxed">{data.description as string}</p>
        <button className="w-full border border-[#E4E7E5] rounded-xl py-2 text-sm text-[#707B73] flex items-center justify-center gap-2 hover:bg-[#F8F9F8] transition-colors nodrag">
          {data.actionLabel === "Generate" ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-[#3655E8]"><path d="M9 3L10.5 9H15L11 12L12.5 18L9 15L5.5 18L7 12L3 9H7.5L9 3Z" fill="currentColor"/></svg>
              Generate
            </>
          ) : (
            <><span className="text-[#B0B8B4] text-base leading-none">+</span> Add</>
          )}
        </button>
      </div>
    </div>
  );
}

function WfCenterNode({ data: _ }: { data: WfNodeData }) {
  const [voiceMode, setVoiceMode] = useState<"voice" | "text">("voice");

  return (
    <div className="bg-white rounded-2xl outline outline-1 outline-offset-[-1px] outline-[#E4E7E5] hover:outline-[#3655E8] transition-all w-[286px] shadow-sm overflow-hidden">
      <Handle type="target" position={Position.Left}  style={{ opacity: 0, pointerEvents: "none", top: 56 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: "none", top: 56 }} />

      {/* Title row */}
      <div className="h-11 flex items-center gap-2.5 px-4 border-b border-[#F1F3F2]">
        <span className="w-6 h-6 rounded-lg bg-indigo-50 border border-indigo-200 flex items-center justify-center shrink-0">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="text-indigo-500"><path fillRule="evenodd" clipRule="evenodd" d="M16.154 3.004C17.739 3.084 19 4.395 19 6V18C19 19.657 17.657 21 16 21H8C6.343 21 5 19.657 5 18V6C5 4.343 6.343 3 8 3H16L16.154 3.004ZM8 4.5C7.172 4.5 6.5 5.172 6.5 6V18C6.5 18.828 7.172 19.5 8 19.5H16C16.828 19.5 17.5 18.828 17.5 18V6C17.5 5.172 16.828 4.5 16 4.5H8Z" fill="currentColor"/></svg>
        </span>
        <span className="text-sm font-semibold text-[#181B19]">AI Call Center</span>
      </div>

      {/* Voice / Text pill toggle */}
      <div className="px-4 pt-3 pb-2">
        <div className="inline-flex items-center bg-[#F1F3F2] rounded-full p-0.5 gap-0.5 nodrag">
          <button
            onClick={() => setVoiceMode("voice")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${voiceMode === "voice" ? "bg-white text-[#181B19] shadow-sm" : "text-[#707B73] hover:text-[#181B19]"}`}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M1.08 5.285C1.444 3.049 2.804 1.539 4.848 1.103C6.043 0.849 7.069 1.066 7.846 1.74C8.174 2.024 9.496 3.596 9.788 4.05C10.27 4.797 10.463 5.858 10.282 6.756C10.127 7.523 9.899 7.931 8.823 9.373C8.28 10.1 7.837 10.736 7.837 10.785C7.838 10.912 8.349 11.96 8.611 12.374C9.008 12.999 9.54 13.64 10.129 14.202C10.682 14.729 11.578 15.4 11.728 15.4C11.767 15.4 12.478 15.053 13.308 14.629C14.97 13.781 15.294 13.671 16.128 13.671C17.095 13.671 18.003 14.035 18.701 14.703C19.283 15.261 20.456 16.701 20.655 17.102C21.159 18.119 21.112 19.152 20.506 20.388C19.906 21.609 18.84 22.483 17.519 22.836C16.933 22.993 15.763 23.048 15.048 22.954C12.85 22.663 10.427 21.485 8.066 19.561C7.174 18.834 5.481 17.103 4.866 16.289C2.747 13.485 1.383 10.444 1.057 7.793C0.972 7.097 0.984 5.891 1.08 5.285Z" fill="currentColor"/></svg>
            Voice Call
          </button>
          <button
            onClick={() => setVoiceMode("text")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${voiceMode === "text" ? "bg-white text-[#181B19] shadow-sm" : "text-[#707B73] hover:text-[#181B19]"}`}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M2.25 4A.75.75 0 013 3.25h18a.75.75 0 010 1.5H3A.75.75 0 012.25 4zm0 4A.75.75 0 013 7.25h18a.75.75 0 010 1.5H3A.75.75 0 012.25 8zm0 4A.75.75 0 013 11.25h12a.75.75 0 010 1.5H3a.75.75 0 01-.75-.75z" fill="currentColor"/></svg>
            Text
          </button>
        </div>
      </div>

      {/* Mini script canvas preview */}
      <div className="mx-4 mb-4 rounded-xl bg-[#F8F9F8] border border-[#ECEEED] overflow-hidden" style={{ height: 109 }}>
        <div className="flex flex-col gap-2 p-3">
          {/* Simulated script node rows */}
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-indigo-100 border border-indigo-200 flex items-center justify-center shrink-0">
              <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
            </div>
            <div className="flex gap-1.5 items-center flex-1">
              <div className="h-1.5 bg-[#E0E7FF] rounded-full" style={{ width: 48 }} />
              <div className="h-1.5 bg-[#D1D5DB] rounded-full" style={{ width: 64 }} />
              <div className="h-1.5 bg-[#BBF7D0] rounded-full" style={{ width: 36 }} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-px h-3 bg-[#D1D5DB] ml-2" />
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center shrink-0">
              <div className="w-1.5 h-1.5 rounded-full bg-gray-300" />
            </div>
            <div className="flex gap-1.5 items-center flex-1">
              <div className="h-1.5 bg-[#FDE68A] rounded-full" style={{ width: 28 }} />
              <div className="h-1.5 bg-[#D1D5DB] rounded-full" style={{ width: 56 }} />
              <div className="h-1.5 bg-[#D1D5DB] rounded-full" style={{ width: 32 }} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-px h-3 bg-[#D1D5DB] ml-2" />
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center shrink-0">
              <div className="w-1.5 h-1.5 rounded-full bg-gray-300" />
            </div>
            <div className="flex gap-1.5 items-center flex-1">
              <div className="h-1.5 bg-[#D1D5DB] rounded-full" style={{ width: 44 }} />
              <div className="h-1.5 bg-[#D1D5DB] rounded-full" style={{ width: 72 }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Step label config ──────────────────────────────────────────────────────

const STEP_CONFIG: Record<StepType, { label: string; color: string; placeholder: string }> = {
  step:             { label: "Step",               color: "#4F46E5", placeholder: 'Type your script… Use {{Variable}} for dynamic fields' },
  schedule_meeting: { label: "Schedule Meeting",   color: "#4F46E5", placeholder: "Let's book a meeting, what day and time works best for you?" },
  sms:              { label: "SMS Phrase",         color: "#4F46E5", placeholder: "Type your SMS phrase…" },
  action:           { label: "Action Phrase",      color: "#B45309", placeholder: "Let me pull that up for you real quick." },
  call_transfer:    { label: "Call Transfer Phrase", color: "#4F46E5", placeholder: "Let me transfer you now…" },
  end_call:         { label: "End Call",           color: "#DC2626", placeholder: "Thank you for your time. Have a great day!" },
};

// ── Main component ─────────────────────────────────────────────────────────

function CampaignEditorInner({ onClose, onSave, nextId, availableGroups, initialName }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("Script");
  const [campaignName, setCampaignName] = useState(initialName?.trim() || "New campaign");
  const [editingName, setEditingName] = useState(false);
  const [scriptPanelOpen, setScriptPanelOpen] = useState(false);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const [steps, setSteps] = useState<ScriptStep[]>([
    { id: 1, type: "step", text: "" },
  ]);
  const nextStepId = useRef(2);
  const [scenarios, setScenarios] = useState<Scenario[]>([
    { id: 1, question: "", steps: [{ id: 1, type: "step", text: "" }] },
  ]);
  const [activeScenario, setActiveScenario] = useState<number | null>(null);
  const [activeScenarioStep, setActiveScenarioStep] = useState<number | null>(null);
  const nextScenarioId = useRef(2);
  const nextScenarioStepId = useRef(2);
  const [generalSettingsOpen, setGeneralSettingsOpen] = useState(false);
  const [useCase, setUseCase] = useState("Not specific");
  const [useCaseOpen, setUseCaseOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<Group>(() => availableGroups.find(g => g !== "Archived") ?? "RND");
  const [selectedStatus, setSelectedStatus] = useState<"Active" | "Paused" | "Stopped">("Active");
  const [groupOpen, setGroupOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [callType, setCallType] = useState<"outgoing" | "incoming">("outgoing");
  const [campaignInstructions, setCampaignInstructions] = useState("");
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [techSettingsOpen, setTechSettingsOpen] = useState(false);
  const [recordCalls, setRecordCalls] = useState(true);
  const [checkFederalDNC, setCheckFederalDNC] = useState(false);
  const [enableLocalDNC, setEnableLocalDNC] = useState(false);
  const [continueAfterCallLater, setContinueAfterCallLater] = useState(true);
  const [sensitiveContent, setSensitiveContent] = useState(false);
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [maxDuration, setMaxDuration] = useState("");
  const [showExamples, setShowExamples] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ScriptNodeData>>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [wfNodes, , onWfNodesChange] = useNodesState<Node<WfNodeData>>(initialWorkflowNodes);
  const scriptFlowRef = useRef<ReactFlowInstance | null>(null);
  const wfFlowRef = useRef<ReactFlowInstance | null>(null);
  const [scriptZoom, setScriptZoom] = useState(100);
  const [wfZoom, setWfZoom] = useState(75);
  const [wfEdges, , onWfEdgesChange] = useEdgesState(initialWorkflowEdges);

  const openScriptPanel = useCallback(() => {
    setScriptPanelOpen(true);
  }, []);

  // Sync steps → canvas nodes so each step appears as a connected node
  useEffect(() => {
    const newNodes: Node<ScriptNodeData>[] = [
      { id: "start", type: "startNode", position: { x: 0, y: 0 }, data: { label: "Start", isStart: true }, draggable: false, selectable: false },
      ...steps.map((step, idx) => {
        const nodeId = idx === 0 ? "intro" : `step-node-${step.id}`;
        const rawLabel = step.text.replace(/\{\{[^}]+\}\}/g, "…").trim();
        const label = rawLabel ? (rawLabel.length > 28 ? rawLabel.substring(0, 28) + "…" : rawLabel) : (idx === 0 ? "Intro Script" : STEP_CONFIG[step.type].label);
        return {
          id: nodeId,
          type: "scriptNode" as const,
          position: { x: -50, y: 80 + idx * 130 },
          data: { label, selected: activeStep === step.id },
        };
      }),
    ];
    const nodeIds = ["start", ...steps.map((s, i) => i === 0 ? "intro" : `step-node-${s.id}`)];
    const newEdges: Edge[] = nodeIds.slice(0, -1).map((id, i) => ({
      id: `e-${id}-${nodeIds[i + 1]}`,
      source: id,
      target: nodeIds[i + 1],
      style: { stroke: "#D1D5DB", strokeWidth: 1.5 },
    }));
    setNodes(newNodes);
    setEdges(newEdges);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, activeStep]);

  function closeScriptPanel() {
    setScriptPanelOpen(false);
    setActiveStep(null);
  }

  function addStep(type: StepType) {
    const id = nextStepId.current++;
    const defaults: Partial<ScriptStep> = {};
    if (type === "schedule_meeting") defaults.meetingService = "Cal.com";
    if (type === "sms")              defaults.smsTemplate = "";
    if (type === "call_transfer")    { defaults.transferPhone = ""; defaults.transferCallerId = "Campaign's number"; defaults.warmTransfer = false; }
    setSteps((prev) => [...prev, { id, type, text: "", ...defaults }]);
    setActiveStep(id);
  }

  function updateStep(id: number, patch: Partial<ScriptStep>) {
    setSteps((prev) => prev.map((s) => s.id === id ? { ...s, ...patch } : s));
  }

  function addScenario() {
    const id = nextScenarioId.current++;
    const stepId = nextScenarioStepId.current++;
    setScenarios((prev) => [...prev, { id, question: "", steps: [{ id: stepId, type: "step", text: "" }] }]);
    setActiveScenario(id);
    setActiveScenarioStep(null);
  }

  function addScenarioWithQuestion(question: string) {
    const id = nextScenarioId.current++;
    const stepId = nextScenarioStepId.current++;
    setScenarios((prev) => [...prev, { id, question, steps: [{ id: stepId, type: "step", text: "" }] }]);
    setActiveScenario(id);
    setActiveScenarioStep(null);
    setShowExamples(false);
  }

  function updateScenarioQuestion(id: number, question: string) {
    setScenarios((prev) => prev.map((s) => s.id === id ? { ...s, question } : s));
  }

  function addScenarioStep(scenarioId: number, type: StepType) {
    const stepId = nextScenarioStepId.current++;
    const defaults: Partial<ScriptStep> = {};
    if (type === "schedule_meeting") defaults.meetingService = "Cal.com";
    if (type === "sms")              defaults.smsTemplate = "";
    if (type === "call_transfer")    { defaults.transferPhone = ""; defaults.transferCallerId = "Campaign's number"; defaults.warmTransfer = false; }
    setScenarios((prev) => prev.map((s) => s.id === scenarioId ? { ...s, steps: [...s.steps, { id: stepId, type, text: "", ...defaults }] } : s));
    setActiveScenarioStep(stepId);
  }

  function updateScenarioStep(scenarioId: number, stepId: number, patch: Partial<ScriptStep>) {
    setScenarios((prev) => prev.map((s) => s.id === scenarioId ? { ...s, steps: s.steps.map((st) => st.id === stepId ? { ...st, ...patch } : st) } : s));
  }

  function deleteScenarioStep(scenarioId: number, stepId: number) {
    setScenarios((prev) => prev.map((s) => s.id === scenarioId ? { ...s, steps: s.steps.filter((st) => st.id !== stepId) } : s));
    if (activeScenarioStep === stepId) setActiveScenarioStep(null);
  }

  function deleteStep(id: number) {
    setSteps((prev) => prev.filter((s) => s.id !== id));
    if (activeStep === id) setActiveStep(null);
  }

  function handleSave() {
    const name = campaignName.trim() || "New campaign";
    onSave({ id: nextId, name, totalContacts: 0, totalCalls: 0, connectRate: "0%", connectCount: 0, successRate: "0%", successCount: 0, status: selectedStatus, group: selectedGroup });
  }

  function renderStepText(text: string) {
    return text.split(/(\{\{[^}]+\}\})/g).map((part, i) => {
      const m = part.match(/^\{\{(.+)\}\}$/);
      if (m) return (
        <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#F0FDF4] border border-[#BBF7D0] text-[#16A34A] text-xs font-medium mx-0.5">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M12 2.25C6.615 2.25 2.25 6.615 2.25 12C2.25 17.385 6.615 21.75 12 21.75C17.385 21.75 21.75 17.385 21.75 12C21.75 6.615 17.385 2.25 12 2.25ZM12.75 8.25C12.75 7.836 12.414 7.5 12 7.5C11.586 7.5 11.25 7.836 11.25 8.25V11.25H8.25C7.836 11.25 7.5 11.586 7.5 12C7.5 12.414 7.836 12.75 8.25 12.75H11.25V15.75C11.25 16.164 11.586 16.5 12 16.5C12.414 16.5 12.75 16.164 12.75 15.75V12.75H15.75C16.164 12.75 16.5 12.414 16.5 12C16.5 11.586 16.164 11.25 15.75 11.25H12.75V8.25Z" fill="currentColor" /></svg>
          {m[1]}
        </span>
      );
      return <span key={i}>{part}</span>;
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#FAFAFA]">

      {/* ── Top Bar ── */}
      {/* Mobile layout: 2 rows */}
      <div className="md:hidden flex flex-col gap-2 px-3 pt-3 pb-2 shrink-0 bg-[#FAFAFA] border-b border-[#E4E7E5]">
        {/* Row 1: name + actions */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0 bg-white rounded-full border border-[#E4E7E5] px-3 py-2 shadow-sm cursor-pointer" onClick={() => setGeneralSettingsOpen(true)}>
            <div className="w-6 h-6 rounded-lg bg-[#4F46E5] flex items-center justify-center shrink-0">
              <span className="text-white font-bold text-xs leading-none">V</span>
            </div>
            {editingName ? (
              <input autoFocus value={campaignName} onChange={(e) => setCampaignName(e.target.value)} onBlur={() => setEditingName(false)} onKeyDown={(e) => { if (e.key === "Enter") setEditingName(false); }} className="text-sm font-semibold bg-transparent outline-none flex-1 min-w-0" onClick={(e) => e.stopPropagation()} />
            ) : (
              <span className="text-sm font-semibold truncate flex-1 min-w-0">{campaignName}</span>
            )}
          </div>
          <button onClick={onClose} className="px-3 py-2 rounded-full border border-[#E4E7E5] bg-white text-sm font-medium text-[#181B19] shadow-sm shrink-0">Cancel</button>
          <button onClick={handleSave} className="px-3 py-2 rounded-full bg-[#4F46E5] text-white text-sm font-semibold shadow-md shrink-0">Save</button>
        </div>
        {/* Row 2: tabs */}
        <div className="flex items-center bg-white rounded-full border border-[#E4E7E5] p-1 shadow-sm gap-1">
          {(["Script", "Scenarios", "Workflow"] as Tab[]).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`flex items-center justify-center gap-1.5 rounded-full px-3 py-2 font-semibold text-xs whitespace-nowrap transition-all grow ${activeTab === tab ? "bg-white text-[#181B19] shadow-sm" : "text-[#707B73]"}`}>
              <TabIcon tab={tab} />{tab}
            </button>
          ))}
        </div>
      </div>

      {/* Desktop layout: 3-column grid */}
      <div className="hidden md:grid items-center px-4 pt-4 pb-0 gap-6 w-full z-10 shrink-0" style={{ gridTemplateColumns: "1fr auto 1fr", minWidth: 752 }}>
        {/* Left */}
        <div className="flex items-center gap-2 min-w-0 justify-start">
          <div className="flex items-center bg-white rounded-full border border-[#E4E7E5] p-1 shadow-sm shrink-0 gap-1.5 px-4" style={{ minWidth: 228 }}>
            <div className="w-8 min-w-8 h-8 rounded-[10px] bg-[#4F46E5] flex items-center justify-center shrink-0">
              <span className="text-white font-bold text-base leading-none">V</span>
            </div>
            <div className="flex items-center gap-2 rounded-full bg-white px-[14px] py-[11px] text-[#181B19] cursor-pointer hover:bg-[#0000000A] grow overflow-hidden" onClick={() => setGeneralSettingsOpen(true)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="shrink-0"><path fillRule="evenodd" clipRule="evenodd" d="M8.61 6C8.61 5.586 8.946 5.25 9.36 5.25H18C18.414 5.25 18.75 5.586 18.75 6V14.64C18.75 15.054 18.414 15.39 18 15.39C17.586 15.39 17.25 15.054 17.25 14.64V7.811L6.53 18.53C6.237 18.823 5.763 18.823 5.47 18.53C5.177 18.237 5.177 17.763 5.47 17.47L16.189 6.75H9.36C8.946 6.75 8.61 6.414 8.61 6Z" fill="currentColor" /></svg>
              {editingName ? (
                <input autoFocus value={campaignName} onChange={(e) => setCampaignName(e.target.value)} onBlur={() => setEditingName(false)} onKeyDown={(e) => { if (e.key === "Enter") setEditingName(false); }} className="text-base font-semibold bg-transparent outline-none border-b border-gray-400 min-w-[120px] max-w-[200px]" onClick={(e) => e.stopPropagation()} />
              ) : (
                <span className="text-base font-semibold whitespace-nowrap truncate">{campaignName}</span>
              )}
            </div>
          </div>
          <div className="flex items-center bg-white rounded-full border border-[#E4E7E5] p-1 shadow-sm shrink-0 gap-1">
            <button className="p-3 rounded-full hover:bg-[#0000000A] text-[#181B19]"><ShareIcon /></button>
            <button className="p-3 rounded-full hover:bg-[#0000000A] text-[#181B19]"><PlusIcon /></button>
          </div>
        </div>
        {/* Center */}
        <div className="flex items-center justify-center" style={{ minWidth: "fit-content" }}>
          <div className="flex items-center bg-white rounded-full border border-[#E4E7E5] p-1 shadow-sm gap-1" style={{ minWidth: 280 }}>
            {(["Script", "Scenarios", "Workflow"] as Tab[]).map((tab) => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`flex items-center justify-center gap-2 rounded-full px-4 py-2.5 font-semibold text-sm whitespace-nowrap transition-all grow ${activeTab === tab ? "bg-white text-[#181B19] shadow-sm" : "text-[#707B73] hover:text-[#181B19] hover:bg-[#0000000A]"}`}>
                <TabIcon tab={tab} />{tab}
              </button>
            ))}
          </div>
        </div>
        {/* Right */}
        <div className="flex items-center gap-2 justify-end">
          <div className="flex items-center bg-white rounded-full border border-[#E4E7E5] p-1 shadow-sm gap-1">
            <button className="p-3 rounded-full hover:bg-[#0000000A] text-[#181B19]"><PhoneIcon /></button>
            <button className="p-3 rounded-full hover:bg-[#0000000A] text-[#181B19]"><CalendarIcon /></button>
            <button className="p-3 rounded-full hover:bg-[#0000000A] text-[#181B19]"><PersonIcon /></button>
            <button className="p-3 rounded-full hover:bg-[#0000000A] text-[#181B19]"><SlidersIcon /></button>
          </div>
          <button onClick={onClose} className="px-4 py-2 rounded-full border border-[#E4E7E5] bg-white text-sm font-medium text-[#181B19] hover:bg-[#0000000A] shadow-sm">Cancel</button>
          <button onClick={handleSave} className="px-4 py-2 rounded-full bg-[#4F46E5] hover:bg-[#4338CA] text-white text-sm font-semibold shadow-md">Save</button>
        </div>
      </div>

      {/* ── Canvas + Panel ── */}
      <div className="flex-1 relative overflow-hidden flex min-h-0">

        {/* ── Scenarios tab ── */}
        {activeTab === "Scenarios" && (
          <>
            {/* Scenarios list */}
            <div className="flex-1 flex flex-col overflow-y-auto" style={{ background: "#F5F5F5" }}>
              <div className="flex flex-col items-center px-4 pt-10 pb-6 min-h-full">
                {/* Illustration */}
                <div className="mb-5">
                  <svg width="180" height="130" viewBox="0 0 180 130" fill="none">
                    {/* Card body */}
                    <rect x="22" y="40" width="136" height="80" rx="12" fill="white" stroke="#E5E7EB" strokeWidth="1.5"/>
                    {/* Dome / semicircle on top */}
                    <ellipse cx="90" cy="40" rx="48" ry="38" fill="#C7D2FE"/>
                    {/* Sparkle stars */}
                    <path d="M84 22 L85.2 26 L89 27 L85.2 28 L84 32 L82.8 28 L79 27 L82.8 26 Z" fill="#818CF8"/>
                    <path d="M98 16 L98.8 18.8 L101.5 19.5 L98.8 20.2 L98 23 L97.2 20.2 L94.5 19.5 L97.2 18.8 Z" fill="#6366F1"/>
                    <path d="M75 30 L75.5 31.8 L77 32.2 L75.5 32.6 L75 34.4 L74.5 32.6 L73 32.2 L74.5 31.8 Z" fill="#A5B4FC"/>
                    {/* Lines inside card */}
                    <rect x="42" y="76" width="96" height="7" rx="3.5" fill="#E5E7EB"/>
                    <rect x="55" y="91" width="70" height="7" rx="3.5" fill="#E5E7EB"/>
                    <rect x="64" y="106" width="52" height="7" rx="3.5" fill="#F3F4F6"/>
                  </svg>
                </div>
                {/* Connect Knowledge Base */}
                <button className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 mb-6 px-3 py-1.5 rounded-full border border-gray-200 bg-white shadow-sm hover:shadow transition-all">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M3.83714 8.42557C3.44927 8.90831 3.08769 9.39717 2.75378 9.88872C1.66828 7.09689 1.7169 4.58253 3.14973 3.14972C4.93713 1.36234 8.40759 1.72898 12.0002 3.76417C15.5927 1.72918 19.0629 1.36264 20.8503 3.14995C22.3754 4.67503 22.3322 7.42545 21.0225 10.4316C20.6838 9.97758 20.3244 9.52862 19.9454 9.08685C20.0068 8.91776 20.0632 8.75051 20.1145 8.58537C20.8122 6.34246 20.4834 4.9044 19.7896 4.2106C19.0958 3.51679 17.6577 3.18806 15.4148 3.88566C14.79 4.07998 14.1351 4.34646 13.4641 4.6826C14.5488 5.43005 15.6254 6.32326 16.651 7.3489C21.5389 12.2367 23.419 18.2814 20.8503 20.8501C19.0629 22.6374 15.5927 22.2708 12.0002 20.2358C8.40758 22.271 4.93713 22.6377 3.14973 20.8503C0.581029 18.2816 2.46109 12.2369 7.34896 7.34913C7.80868 6.88941 8.27864 6.4563 8.75497 6.051C9.19664 6.30016 9.64432 6.57924 10.0941 6.88798C9.52519 7.35062 8.96104 7.85836 8.40962 8.40978C7.24454 9.57485 6.27445 10.7967 5.5127 12C6.27445 13.2033 7.24454 14.4252 8.40962 15.5902C9.08465 16.2652 9.77874 16.8748 10.4772 17.4163C9.99086 17.7048 9.50788 17.9603 9.03289 18.1817C8.46136 17.7107 7.89787 17.1998 7.34896 16.6509C6.32327 15.6252 5.43004 14.5486 4.68256 13.4638C4.34634 14.135 4.07981 14.79 3.88545 15.4149C3.18784 17.6578 3.51658 19.0958 4.21039 19.7896C4.9042 20.4834 6.34228 20.8122 8.58521 20.1146C10.7528 19.4404 13.283 17.8978 15.5904 15.5905C16.0859 15.095 16.5461 14.5892 16.97 14.079C17.283 14.5228 17.5653 14.9646 17.8163 15.3999C17.4496 15.8233 17.0609 16.2412 16.651 16.6511C15.6254 17.6767 14.5488 18.57 13.4641 19.3174C14.1351 19.6535 14.79 19.92 15.4148 20.1143C17.6577 20.8119 19.0958 20.4832 19.7896 19.7894C20.4834 19.0956 20.8122 17.6575 20.1145 15.4146C19.4404 13.247 17.8978 10.7169 15.5904 8.40954C13.283 6.10215 10.7528 4.5596 8.58521 3.88543C6.34228 3.18783 4.9042 3.51656 4.21039 4.21036C3.53317 4.88757 3.20378 6.27386 3.83714 8.42557Z" fill="currentColor"/></svg>
                  Connect Knowledge Base
                </button>
                <h2 className="text-xl font-bold text-gray-900 mb-2">Scenarios</h2>
                <p className="text-sm text-gray-500 text-center mb-8 max-w-[280px]">A scenario is an agent response for specific caller situation</p>

                {/* Question list */}
                <div className="w-full max-w-[420px] flex flex-col gap-2">
                  {scenarios.map((scenario) => (
                    <button key={scenario.id}
                      onClick={() => { setActiveScenario(scenario.id); setActiveScenarioStep(null); }}
                      className={`flex items-center gap-3 px-4 py-3 rounded-xl border bg-white text-left cursor-pointer w-full transition-all ${activeScenario === scenario.id ? "border-[#4F46E5] shadow-[0_0_0_3px_rgba(79,70,229,0.10)]" : "border-gray-200 hover:border-gray-300"}`}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-gray-400 shrink-0"><path d="M12 2C6.477 2 2 6.477 2 12C2 17.523 6.477 22 12 22C17.523 22 22 17.523 22 12C22 6.477 17.523 2 12 2ZM12 17C11.448 17 11 16.552 11 16C11 15.448 11.448 15 12 15C12.552 15 13 15.448 13 16C13 16.552 12.552 17 12 17ZM13 13H11V8H13V13Z" fill="currentColor"/></svg>
                      <span className="text-sm text-gray-700">{scenario.question || "Question"}</span>
                    </button>
                  ))}
                  {/* Add button */}
                  <div className="flex justify-center mt-2">
                    <button onClick={addScenario} className="w-8 h-8 rounded-full border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 flex items-center justify-center text-lg shadow-sm hover:shadow transition-all">+</button>
                  </div>
                </div>
              </div>
              {/* Show/Hide examples toggle */}
              <div className="flex flex-col items-center pb-6 pt-4 px-4">
                <button
                  onClick={() => setShowExamples((v) => !v)}
                  className="flex flex-col items-center gap-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest hover:text-gray-600"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className={`transition-transform ${showExamples ? "rotate-180" : ""}`}>
                    <path d="M12 4L4 12H9V20H15V12H20L12 4Z" fill="currentColor"/>
                  </svg>
                  {showExamples ? "Hide Scenarios Examples" : "Show Scenarios Examples"}
                </button>

                {showExamples && (() => {
                  const EXAMPLES = [
                    "If the prospect inquires about pricing",
                    "If the prospect asks for a callback at a different time",
                    "If the prospect doesn't want to book a meeting",
                    "If the prospect asks for the location of the company",
                    "If the prospect asks how long the company has been in business",
                    "If the prospect asks for contact information",
                    "If the prospect asks how the assistant got their number",
                    "If the prospect asks if you are a robot",
                    "If the prospect asks about integrations",
                    "If the prospect asks about the industries we serve",
                    "If the prospect wants to talk with a real person",
                    "If the prospect asks about products and services",
                  ];
                  return (
                    <div className="mt-4 w-full max-w-3xl grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {EXAMPLES.map((ex) => {
                        const alreadyAdded = scenarios.some(s => s.question === ex);
                        return (
                          <div key={ex} className="flex items-center justify-between gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-left hover:border-gray-300 transition-all">
                            <span className="text-xs text-gray-700 leading-snug">{ex}</span>
                            <button
                              onClick={() => !alreadyAdded && addScenarioWithQuestion(ex)}
                              disabled={alreadyAdded}
                              className={`shrink-0 w-6 h-6 rounded-full border flex items-center justify-center text-sm font-medium transition-colors ${alreadyAdded ? "border-green-300 text-green-500 cursor-default" : "border-gray-300 text-gray-500 hover:border-[#4F46E5] hover:text-[#4F46E5] hover:bg-[#F5F3FF]"}`}
                            >
                              {alreadyAdded ? "✓" : "+"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Scenario right panel */}
            {activeScenario !== null && (() => {
              const scenario = scenarios.find((s) => s.id === activeScenario);
              if (!scenario) return null;
              return (
                <div className="w-[680px] shrink-0 bg-white border-l border-gray-100 flex flex-col shadow-[-8px_0_32px_0_rgba(0,0,0,0.06)] overflow-y-auto">
                  {/* Header */}
                  <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-100 sticky top-0 bg-white z-10">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-gray-400 shrink-0"><path d="M12 2C6.477 2 2 6.477 2 12C2 17.523 6.477 22 12 22C17.523 22 22 17.523 22 12C22 6.477 17.523 2 12 2ZM12 17C11.448 17 11 16.552 11 16C11 15.448 11.448 15 12 15C12.552 15 13 15.448 13 16C13 16.552 12.552 17 12 17ZM13 13H11V8H13V13Z" fill="currentColor"/></svg>
                    <input autoFocus value={scenario.question} onChange={(e) => updateScenarioQuestion(scenario.id, e.target.value)} placeholder="Type question here" className="flex-1 text-sm text-gray-700 bg-transparent outline-none placeholder-gray-300" />
                    <div className="flex items-center gap-1">
                      <button className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/></svg>
                      </button>
                      <button onClick={() => setActiveScenario(null)} className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M5.47 5.47a.75.75 0 011.06 0L12 10.94l5.47-5.47a.75.75 0 111.06 1.06L13.06 12l5.47 5.47a.75.75 0 11-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 01-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 010-1.06z" fill="currentColor"/></svg>
                      </button>
                    </div>
                  </div>
                  {/* Steps */}
                  <div className="px-5 py-4 flex flex-col gap-1 flex-1">
                    {scenario.steps.map((step, idx) => {
                      const isActive = activeScenarioStep === step.id;
                      const cfg = STEP_CONFIG[step.type];
                      return (
                        <div key={step.id} className="flex gap-3">
                          <div className="flex flex-col items-center shrink-0 pt-1 w-7">
                            <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-xs font-semibold text-gray-500">{idx + 1}</div>
                            {idx < scenario.steps.length - 1 && <div className="w-px flex-1 bg-gray-200 mt-1 min-h-[12px]" />}
                          </div>
                          <div className="flex-1 mb-2">
                            <StepCard step={step} idx={idx} isActive={isActive} cfg={cfg}
                              onToggle={() => setActiveScenarioStep(isActive ? null : step.id)}
                              onUpdate={(patch) => updateScenarioStep(scenario.id, step.id, patch)}
                              onDelete={() => deleteScenarioStep(scenario.id, step.id)}
                              canDelete={scenario.steps.length > 1}
                              renderStepText={renderStepText}
                            />
                          </div>
                        </div>
                      );
                    })}
                    {/* Add action row */}
                    <div className="flex gap-3 mt-1">
                      <div className="w-7 shrink-0 flex justify-center pt-1">
                        <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-xs font-semibold text-gray-500">{scenario.steps.length + 1}</div>
                      </div>
                      <div className="flex-1 flex flex-wrap gap-2 pt-0.5 pb-6">
                        {(["Step", "Schedule a Meeting", "SMS", "Action", "Call Transfer", "End Call"] as const).map((label) => {
                          const typeMap: Record<string, StepType> = { "Step": "step", "Schedule a Meeting": "schedule_meeting", "SMS": "sms", "Action": "action", "Call Transfer": "call_transfer", "End Call": "end_call" };
                          return (
                            <button key={label} onClick={() => addScenarioStep(scenario.id, typeMap[label])}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-gray-200 bg-white text-xs font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-300 shadow-sm transition-colors">
                              <span className="text-gray-400 text-sm leading-none">+</span>{label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}
          </>
        )}

        {/* ── Script tab ── */}
        {activeTab === "Script" && (<>
        <div className="flex-1 relative" style={{ background: "#F5F5F5" }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, node) => {
              if (node.type === "scriptNode") {
                openScriptPanel();
                const stepIdx = node.id === "intro" ? 0 : steps.findIndex(s => `step-node-${s.id}` === node.id);
                if (stepIdx >= 0) setActiveStep(steps[stepIdx].id);
              }
            }}
            nodeTypes={nodeTypes}
            fitView fitViewOptions={{ padding: 0.5 }}
            minZoom={0.25} maxZoom={2}
            panOnScroll zoomOnScroll
            nodesDraggable nodesConnectable={false} elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
            onInit={(instance) => { scriptFlowRef.current = instance; }}
            onMoveEnd={(_, vp) => setScriptZoom(Math.round(vp.zoom * 100))}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#D1D5DB" />
          </ReactFlow>
          <div className="hidden md:flex absolute bottom-6 left-1/2 -translate-x-1/2 items-center bg-white rounded-full border border-gray-200 shadow-sm gap-1 px-1 py-1 z-10">
            <button onClick={() => { scriptFlowRef.current?.zoomIn(); }} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-700 text-lg font-medium">+</button>
            <button onClick={() => { scriptFlowRef.current?.zoomOut(); }} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-700 text-lg font-medium">−</button>
            <span className="text-sm text-gray-600 px-2 min-w-[48px] text-center">{scriptZoom}%</span>
          </div>
        </div>

        {/* ── Script panel ── */}
        {scriptPanelOpen && (
          <div className="w-full md:w-[680px] md:shrink-0 bg-white border-l border-gray-100 flex flex-col shadow-[-8px_0_32px_0_rgba(0,0,0,0.06)] overflow-y-auto">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white z-10">
              <h3 className="text-base font-semibold text-gray-900">Intro Script</h3>
              <div className="flex items-center gap-1">
                <button className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/></svg>
                </button>
                <button onClick={closeScriptPanel} className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M5.47 5.47a.75.75 0 011.06 0L12 10.94l5.47-5.47a.75.75 0 111.06 1.06L13.06 12l5.47 5.47a.75.75 0 11-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 01-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 010-1.06z" fill="currentColor"/></svg>
                </button>
              </div>
            </div>

            {/* Steps */}
            <div className="px-5 py-4 flex flex-col gap-1 flex-1">
              {steps.map((step, idx) => {
                const isActive = activeStep === step.id;
                const cfg = STEP_CONFIG[step.type];
                return (
                  <div key={step.id} className="flex gap-3">
                    {/* Left rail */}
                    <div className="flex flex-col items-center shrink-0 pt-1 w-7">
                      {isActive && idx > 0 && (
                        <button className="w-5 h-5 flex items-center justify-center text-gray-300 hover:text-gray-500 mb-1">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 4L6 10H18L12 4Z" fill="currentColor"/></svg>
                        </button>
                      )}
                      <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-xs font-semibold text-gray-500">{idx + 1}</div>
                      {idx < steps.length - 1 && <div className="w-px flex-1 bg-gray-200 mt-1 min-h-[12px]" />}
                    </div>

                    {/* Card */}
                    <div className="flex-1 mb-2">
                      <StepCard
                        step={step}
                        idx={idx}
                        isActive={isActive}
                        cfg={cfg}
                        onToggle={() => setActiveStep(isActive ? null : step.id)}
                        onUpdate={(patch) => updateStep(step.id, patch)}
                        onDelete={() => deleteStep(step.id)}
                        canDelete={steps.length > 1}
                        renderStepText={renderStepText}
                      />
                    </div>
                  </div>
                );
              })}

              {/* Add action row */}
              <div className="flex gap-3 mt-1">
                <div className="w-7 shrink-0 flex justify-center pt-1">
                  <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-xs font-semibold text-gray-500">{steps.length + 1}</div>
                </div>
                <div className="flex-1 flex flex-wrap gap-2 pt-0.5 pb-6">
                  {(["Step", "Schedule a Meeting", "SMS", "Action", "Call Transfer", "End Call"] as const).map((label) => {
                    const typeMap: Record<string, StepType> = { "Step": "step", "Schedule a Meeting": "schedule_meeting", "SMS": "sms", "Action": "action", "Call Transfer": "call_transfer", "End Call": "end_call" };
                    return (
                      <button key={label} onClick={() => addStep(typeMap[label])}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-gray-200 bg-white text-xs font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-300 shadow-sm transition-colors">
                        <span className="text-gray-400 text-sm leading-none">+</span>{label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
        </>)}

        {/* ── Workflow tab ── */}
        {activeTab === "Workflow" && (
          <div className="flex-1 relative" style={{ background: "#F5F5F5" }}>
            <ReactFlow
              nodes={wfNodes}
              edges={wfEdges}
              onNodesChange={onWfNodesChange}
              onEdgesChange={onWfEdgesChange}
              nodeTypes={nodeTypes}
              fitView fitViewOptions={{ padding: 0.3 }}
              minZoom={0.25} maxZoom={2}
              panOnScroll zoomOnScroll
              nodesDraggable nodesConnectable={false} elementsSelectable={false}
              proOptions={{ hideAttribution: true }}
              onInit={(instance) => { wfFlowRef.current = instance; }}
              onMoveEnd={(_, vp) => setWfZoom(Math.round(vp.zoom * 100))}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#D1D5DB" />
            </ReactFlow>
            <div className="hidden md:flex absolute bottom-6 left-1/2 -translate-x-1/2 items-center bg-white rounded-full border border-gray-200 shadow-sm gap-1 px-1 py-1 z-10">
              <button onClick={() => { wfFlowRef.current?.zoomIn(); }} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-700 text-lg font-medium">+</button>
              <button onClick={() => { wfFlowRef.current?.zoomOut(); }} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-700 text-lg font-medium">−</button>
              <span className="text-sm text-gray-600 px-2 min-w-[48px] text-center">{wfZoom}%</span>
            </div>
          </div>
        )}
      </div>

      {/* ── General Settings Modal ── */}
      {generalSettingsOpen && (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center overflow-y-auto" style={{ pointerEvents: "auto" }} onClick={() => { setGeneralSettingsOpen(false); setUseCaseOpen(false); setGroupOpen(false); setStatusOpen(false); }}>
          <div className="relative bg-white shadow-[0_24px_48px_-12px_rgba(0,0,0,0.18)] flex flex-col w-full mx-0 sm:mx-4 sm:rounded-2xl sm:max-w-[700px] max-h-[100dvh] sm:max-h-[95vh] overflow-hidden rounded-none" onClick={(e) => e.stopPropagation()}>

            {/* ── Header ── */}
            <div className="sticky top-0 bg-white z-10 shadow-sm">
              <div className="flex justify-between items-center px-6 py-4">
                <div className="flex items-center gap-4">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M11.13 1.037C10.637 1.108 10.107 1.223 9.631 1.363L9.426 1.423L9.224 1.783C8.905 2.35 8.349 3.481 8.151 3.968C7.989 4.363 7.95 4.432 7.799 4.584C7.557 4.829 7.361 4.899 6.972 4.879C6.812 4.87 6.474 4.835 6.221 4.8C5.747 4.735 4.812 4.661 4.026 4.626L3.576 4.606L3.172 5C2.95 5.217 2.657 5.532 2.521 5.701C1.809 6.586 1.268 7.695 1.021 8.777C0.993 8.897 1.991 10.304 2.713 11.162C3.086 11.606 3.156 11.759 3.136 12.082C3.118 12.363 3.062 12.468 2.677 12.931C2.145 13.57 1.576 14.338 1.112 15.043L1 15.212L1.074 15.488C1.462 16.94 2.281 18.279 3.373 19.248L3.587 19.438L4.108 19.417C4.864 19.388 5.743 19.314 6.38 19.228C6.686 19.187 7.006 19.153 7.091 19.153C7.386 19.153 7.752 19.345 7.908 19.581C7.952 19.648 8.089 19.936 8.212 20.222C8.447 20.77 8.967 21.812 9.262 22.328L9.437 22.635L9.884 22.747C10.648 22.938 11.164 23 11.995 23C12.906 23 13.642 22.902 14.371 22.685L14.588 22.62L14.805 22.229C15.286 21.36 15.621 20.668 15.959 19.85C16.127 19.444 16.462 19.189 16.864 19.161C16.981 19.153 17.247 19.174 17.508 19.211C18.239 19.318 19.651 19.429 20.262 19.429H20.458L20.936 18.946C21.736 18.137 22.244 17.374 22.637 16.394C22.784 16.028 22.99 15.353 22.99 15.239C22.99 15.122 22.029 13.768 21.461 13.085C20.905 12.415 20.876 12.362 20.877 12.008C20.877 11.724 20.962 11.563 21.354 11.097C21.751 10.624 22.311 9.874 22.707 9.284L23 8.847L22.961 8.67C22.857 8.193 22.555 7.395 22.296 6.913C22.112 6.569 21.762 6.037 21.519 5.732C21.293 5.448 20.848 4.98 20.594 4.759L20.418 4.606L19.705 4.641C18.881 4.681 18.162 4.743 17.554 4.828C16.783 4.936 16.546 4.896 16.234 4.602C16.08 4.457 16.047 4.398 15.837 3.909C15.559 3.263 15.228 2.589 14.859 1.92L14.584 1.422L14.415 1.372C14.053 1.266 13.555 1.149 13.189 1.083C12.699 0.996 11.593 0.972 11.13 1.037ZM12 8C9.791 8 8 9.791 8 12C8 14.209 9.791 16 12 16C14.209 16 16 14.209 16 12C16 9.791 14.209 8 12 8ZM12 9.5C13.381 9.5 14.5 10.619 14.5 12C14.5 13.381 13.381 14.5 12 14.5C10.619 14.5 9.5 13.381 9.5 12C9.5 10.619 10.619 9.5 12 9.5Z" fill="#707B73"/></svg>
                  <span className="text-[#181b18] text-base font-semibold">General Settings</span>
                </div>
                <button onClick={() => setGeneralSettingsOpen(false)} className="flex items-center justify-center p-2 rounded-lg hover:bg-neutral-50">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M20.485 3.515a.75.75 0 00-1.06 0L12 10.94 4.575 3.515a.75.75 0 10-1.06 1.06L10.94 12l-7.425 7.425a.75.75 0 101.06 1.06L12 13.06l7.425 7.425a.75.75 0 101.06-1.06L13.06 12l7.425-7.425a.75.75 0 000-1.06z" fill="#707B73"/></svg>
                </button>
              </div>
              <div className="w-full h-px bg-[#E4E7E5]" />
            </div>

            {/* ── Scrollable body ── */}
            <div className="flex-grow overflow-y-auto p-6 flex flex-col gap-6" style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}>

              {/* Campaign name – floating label */}
              <div className="relative w-full">
                <div className="overflow-auto bg-[#00000005] hover:bg-[#0000000A] transition-colors border border-[#00000014] hover:border-[#00000029] rounded-2xl">
                  <div className="relative w-full">
                    <input
                      value={campaignName}
                      onChange={(e) => setCampaignName(e.target.value)}
                      placeholder=" "
                      className="peer resize-none w-full block text-base text-black bg-transparent focus:outline-none focus:ring-0 caret-[#3655E8] h-14 pl-4 pr-4 pb-2 pt-6"
                    />
                    <label className="absolute text-base font-normal text-[#00000066] duration-300 transform -translate-y-3 scale-75 origin-[0] start-4 top-4 peer-placeholder-shown:scale-100 peer-placeholder-shown:translate-y-0 peer-focus:scale-75 peer-focus:-translate-y-3 peer-focus:text-[#3655E8] pointer-events-none">
                      Campaign name
                    </label>
                  </div>
                </div>
              </div>

              {/* Use case */}
              <div className="relative w-full">
                <div className="w-full inline-flex flex-col bg-transparent rounded-2xl outline outline-1 outline-offset-[-1px] outline-[rgba(0,0,0,0.1)] hover:outline-[rgba(0,0,0,0.2)] transition-all">
                  <button onClick={() => { setUseCaseOpen(!useCaseOpen); setGroupOpen(false); setStatusOpen(false); }} className="h-14 px-4 py-2 flex items-center gap-2 cursor-pointer">
                    <div className="flex-1 flex items-center justify-between">
                      <div className="flex items-center gap-0.5">
                        <span className="text-zinc-900 text-base font-normal">Use case</span>
                        <span className="text-neutral-400 text-base font-normal">(optional)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-neutral-500 text-base">{useCase}</span>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ transform: useCaseOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 200ms ease-in-out" }}><path fillRule="evenodd" clipRule="evenodd" d="M3.70083 6.72323C3.37466 6.86581 3.2364 7.29113 3.40825 7.62366C3.55749 7.91246 9.65328 14.1052 9.8324 14.1499C9.92172 14.1722 10.0678 14.1722 10.1571 14.1499C10.3362 14.1052 16.432 7.91246 16.5812 7.62366C16.7261 7.34347 16.6887 7.10203 16.4651 6.87259C16.3067 6.71015 16.2166 6.66666 16.0385 6.66666C15.819 6.66666 15.7288 6.75254 12.9034 9.64918L9.99415 12.6318L7.11463 9.67783C4.60089 7.09919 4.20907 6.72038 4.03031 6.69628C3.91767 6.68113 3.76943 6.69325 3.70083 6.72323Z" fill="#737373"/></svg>
                      </div>
                    </div>
                  </button>
                </div>
                {useCaseOpen && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-[#E4E7E5] rounded-2xl shadow-lg z-20 overflow-hidden">
                    {["Not specific", "Cold Outreach", "Inbound", "Pre-qualification", "Event Confirmation", "Lead Revival", "Welcome & Onboarding"].map((opt) => (
                      <button key={opt} onClick={() => { setUseCase(opt); setUseCaseOpen(false); }} className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-50 ${useCase === opt ? "text-[#3655E8] font-medium" : "text-zinc-900"}`}>{opt}</button>
                    ))}
                  </div>
                )}
              </div>

              {/* Outgoing / Incoming */}
              <div className="flex gap-3">
                {([
                  { key: "outgoing", label: "Outgoing", desc: "Start the campaign by sending messages or making calls to your contacts.", icon: <path fillRule="evenodd" clipRule="evenodd" d="M8.61 6C8.61 5.586 8.946 5.25 9.36 5.25H18C18.414 5.25 18.75 5.586 18.75 6V14.64C18.75 15.054 18.414 15.39 18 15.39C17.586 15.39 17.25 15.054 17.25 14.64V7.811L6.53 18.53C6.237 18.823 5.763 18.823 5.47 18.53C5.177 18.237 5.177 17.763 5.47 17.47L16.189 6.75H9.36C8.946 6.75 8.61 6.414 8.61 6Z" fill="black"/> },
                  { key: "incoming", label: "Incoming", desc: "Handle incoming calls, callbacks, or new messages from your contacts.", icon: <path fillRule="evenodd" clipRule="evenodd" d="M15.39 18C15.39 18.414 15.054 18.75 14.64 18.75L6 18.75C5.586 18.75 5.25 18.414 5.25 18L5.25 9.36C5.25 8.946 5.586 8.61 6 8.61C6.414 8.61 6.75 8.946 6.75 9.36L6.75 16.189L17.47 5.47C17.763 5.177 18.237 5.177 18.53 5.47C18.823 5.763 18.823 6.237 18.53 6.53L7.811 17.25L14.64 17.25C15.054 17.25 15.39 17.586 15.39 18Z" fill="black"/> },
                ] as const).map(({ key, label, desc, icon }) => {
                  const isSelected = callType === key;
                  return (
                    <button key={key} onClick={() => setCallType(key)} className={`w-full transition-colors border bg-transparent cursor-pointer rounded-3xl px-5 py-4 text-left ${isSelected ? "border-[#3655E8] bg-[#FAFAFA]" : "border-[#E4E4E7] hover:border-[#3655E8] hover:bg-[#FAFAFA]"}`}>
                      <div className="flex justify-between items-start mb-3">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="ml-2">{icon}</svg>
                        <div className={`flex items-center justify-center border transition-colors rounded-md w-5 h-5 flex-shrink-0 ${isSelected ? "bg-[#3655E8] border-[#3655E8]" : "bg-transparent border-[#E4E4E7]"}`}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M19.409 3.143a.75.75 0 00-1.06.354L14.511 10.35 9.745 17.42a.54.54 0 01-.37.18c-.14 0-.262-.062-.37-.18L6.786 14.96a.75.75 0 10-1.06 1.34l2.25 2.538c.362.409 1.003.44 1.406.069a.74.74 0 00.162-.176l4.802-7.128 3.867-7.2a.75.75 0 00-.354-1.26z" fill={isSelected ? "white" : "transparent"}/></svg>
                        </div>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <h4 className="font-semibold text-base text-[#18181B]">{label}</h4>
                        <p className="text-sm text-[#70707B] max-w-[85%]">{desc}</p>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Group */}
              <div className="relative w-full">
                <div className="w-full inline-flex flex-col bg-transparent rounded-2xl outline outline-1 outline-offset-[-1px] outline-[rgba(0,0,0,0.1)] hover:outline-[rgba(0,0,0,0.2)] transition-all">
                  <button onClick={() => { setGroupOpen(!groupOpen); setStatusOpen(false); setUseCaseOpen(false); }} className="h-14 px-4 py-2 flex items-center gap-2 cursor-pointer">
                    <div className="flex-1 flex items-center justify-between">
                      <span className="text-zinc-900 text-base font-normal">Group</span>
                      <div className="flex items-center gap-2">
                        <span className="text-neutral-500 text-base">{selectedGroup}</span>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ transform: groupOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 200ms ease-in-out" }}><path fillRule="evenodd" clipRule="evenodd" d="M3.70083 6.72323C3.37466 6.86581 3.2364 7.29113 3.40825 7.62366C3.55749 7.91246 9.65328 14.1052 9.8324 14.1499C9.92172 14.1722 10.0678 14.1722 10.1571 14.1499C10.3362 14.1052 16.432 7.91246 16.5812 7.62366C16.7261 7.34347 16.6887 7.10203 16.4651 6.87259C16.3067 6.71015 16.2166 6.66666 16.0385 6.66666C15.819 6.66666 15.7288 6.75254 12.9034 9.64918L9.99415 12.6318L7.11463 9.67783C4.60089 7.09919 4.20907 6.72038 4.03031 6.69628C3.91767 6.68113 3.76943 6.69325 3.70083 6.72323Z" fill="#737373"/></svg>
                      </div>
                    </div>
                  </button>
                </div>
                {groupOpen && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-[#E4E7E5] rounded-2xl shadow-lg z-20 overflow-hidden">
                    {availableGroups.filter(g => g !== "Archived").map((g) => (
                      <button key={g} onClick={() => { setSelectedGroup(g); setGroupOpen(false); }} className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-50 ${selectedGroup === g ? "text-[#3655E8] font-medium" : "text-zinc-900"}`}>{g}</button>
                    ))}
                  </div>
                )}
              </div>

              {/* Status */}
              <div className="relative w-full">
                <div className="w-full inline-flex flex-col bg-transparent rounded-2xl outline outline-1 outline-offset-[-1px] outline-[rgba(0,0,0,0.1)] hover:outline-[rgba(0,0,0,0.2)] transition-all">
                  <button onClick={() => { setStatusOpen(!statusOpen); setGroupOpen(false); setUseCaseOpen(false); }} className="h-14 px-4 py-2 flex items-center gap-2 cursor-pointer">
                    <div className="flex-1 flex items-center justify-between">
                      <span className="text-zinc-900 text-base font-normal">Status</span>
                      <div className="flex items-center gap-2">
                        <span className="text-neutral-500 text-base">{selectedStatus}</span>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ transform: statusOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 200ms ease-in-out" }}><path fillRule="evenodd" clipRule="evenodd" d="M3.70083 6.72323C3.37466 6.86581 3.2364 7.29113 3.40825 7.62366C3.55749 7.91246 9.65328 14.1052 9.8324 14.1499C9.92172 14.1722 10.0678 14.1722 10.1571 14.1499C10.3362 14.1052 16.432 7.91246 16.5812 7.62366C16.7261 7.34347 16.6887 7.10203 16.4651 6.87259C16.3067 6.71015 16.2166 6.66666 16.0385 6.66666C15.819 6.66666 15.7288 6.75254 12.9034 9.64918L9.99415 12.6318L7.11463 9.67783C4.60089 7.09919 4.20907 6.72038 4.03031 6.69628C3.91767 6.68113 3.76943 6.69325 3.70083 6.72323Z" fill="#737373"/></svg>
                      </div>
                    </div>
                  </button>
                </div>
                {statusOpen && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-[#E4E7E5] rounded-2xl shadow-lg z-20 overflow-hidden">
                    {(["Active", "Paused", "Stopped"] as const).map((s) => (
                      <button key={s} onClick={() => { setSelectedStatus(s); setStatusOpen(false); }} className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-50 ${selectedStatus === s ? "text-[#3655E8] font-medium" : "text-zinc-900"}`}>{s}</button>
                    ))}
                  </div>
                )}
              </div>

              <div className="w-full h-px bg-[#E4E7E5]" />

              {/* Campaign Instructions accordion */}
              <section className="w-full border rounded-2xl p-4 hover:bg-[#FAFAFA] transition-colors">
                <button type="button" onClick={() => setInstructionsOpen(!instructionsOpen)} className="w-full text-left flex items-center justify-between font-medium hover:bg-[#FAFAFA] transition-colors focus:outline-none">
                  <div className="flex items-center gap-4">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M20.5 6V12.544C21.0498 12.7964 21.5548 13.1293 22 13.5278V6C22 3.23858 19.7614 1 17 1H7C4.23858 1 2 3.23858 2 6V18C2 20.7614 4.23858 23 7 23H14.6822C14.0774 22.5978 13.5497 22.0889 13.126 21.5H7C5.067 21.5 3.5 19.933 3.5 18V6C3.5 4.067 5.067 2.5 7 2.5H17C18.933 2.5 20.5 4.067 20.5 6ZM18.75 15C18.75 14.5858 18.4142 14.25 18 14.25C17.5858 14.25 17.25 14.5858 17.25 15V17.5H14.75C14.3358 17.5 14 17.8358 14 18.25C14 18.6642 14.3358 19 14.75 19H17.25V21.5C17.25 21.9142 17.5858 22.25 18 22.25C18.4142 22.25 18.75 21.9142 18.75 21.5V19H21.25C21.6642 19 22 18.6642 22 18.25C22 17.8358 21.6642 17.5 21.25 17.5H18.75V15ZM7 6.25C6.58579 6.25 6.25 6.58579 6.25 7C6.25 7.41421 6.58579 7.75 7 7.75H17C17.4142 7.75 17.75 7.41421 17.75 7C17.75 6.58579 17.4142 6.25 17 6.25H7ZM6.25 11C6.25 10.5858 6.58579 10.25 7 10.25H17C17.4142 10.25 17.75 10.5858 17.75 11C17.75 11.4142 17.4142 11.75 17 11.75H7C6.58579 11.75 6.25 11.4142 6.25 11ZM7 14.25C6.58579 14.25 6.25 14.5858 6.25 15C6.25 15.4142 6.58579 15.75 7 15.75H13C13.4142 15.75 13.75 15.4142 13.75 15C13.75 14.5858 13.4142 14.25 13 14.25H7Z" fill="#707B73"/></svg>
                    <span className="text-zinc-900 text-base font-normal">Campaign Instructions</span>
                  </div>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ transform: instructionsOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 300ms ease-in-out" }}><path fillRule="evenodd" clipRule="evenodd" d="M3.70083 6.72323C3.37466 6.86581 3.2364 7.29113 3.40825 7.62366C3.55749 7.91246 9.65328 14.1052 9.8324 14.1499C9.92172 14.1722 10.0678 14.1722 10.1571 14.1499C10.3362 14.1052 16.432 7.91246 16.5812 7.62366C16.7261 7.34347 16.6887 7.10203 16.4651 6.87259C16.3067 6.71015 16.2166 6.66666 16.0385 6.66666C15.819 6.66666 15.7288 6.75254 12.9034 9.64918L9.99415 12.6318L7.11463 9.67783C4.60089 7.09919 4.20907 6.72038 4.03031 6.69628C3.91767 6.68113 3.76943 6.69325 3.70083 6.72323Z" fill="#70707B"/></svg>
                </button>
                {instructionsOpen && (
                  <div className="flex flex-col gap-4 pt-4">
                    <div className="relative w-full h-full">
                      <textarea
                        value={campaignInstructions}
                        onChange={(e) => setCampaignInstructions(e.target.value)}
                        placeholder=" "
                        className="peer resize-none w-full block px-4 pb-2.5 pt-6 text-base text-black bg-[#00000005] appearance-none focus:outline-none hover:bg-[#0000000A] focus:bg-[#0000000A] caret-[#3655E8] rounded-2xl border border-[#00000014] hover:border-[#00000029] min-h-[100px]"
                      />
                      <label className="pointer-events-none transition-all text-[#00000066] text-base absolute left-4 top-[6px] translate-y-0 text-xs">Type instructions here</label>
                    </div>
                  </div>
                )}
              </section>

              {/* Technical Settings accordion */}
              <section className="w-full border rounded-2xl p-4 hover:bg-[#FAFAFA] transition-colors">
                <button type="button" onClick={() => setTechSettingsOpen(!techSettingsOpen)} className="w-full text-left flex items-center justify-between font-medium focus:outline-none">
                  <div className="flex items-center gap-4">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M11.13 1.037C10.637 1.108 10.107 1.223 9.631 1.363L9.426 1.423L9.224 1.783C8.905 2.35 8.349 3.481 8.151 3.968C7.989 4.363 7.95 4.432 7.799 4.584C7.557 4.829 7.361 4.899 6.972 4.879C6.812 4.87 6.474 4.835 6.221 4.8C5.747 4.735 4.812 4.661 4.026 4.626L3.576 4.606L3.172 5C2.95 5.217 2.657 5.532 2.521 5.701C1.809 6.586 1.268 7.695 1.021 8.777C0.993 8.897 1.991 10.304 2.713 11.162C3.086 11.606 3.156 11.759 3.136 12.082C3.118 12.363 3.062 12.468 2.677 12.931C2.145 13.57 1.576 14.338 1.112 15.043L1 15.212L1.074 15.488C1.462 16.94 2.281 18.279 3.373 19.248L3.587 19.438L4.108 19.417C4.864 19.388 5.743 19.314 6.38 19.228C6.686 19.187 7.006 19.153 7.091 19.153C7.386 19.153 7.752 19.345 7.908 19.581C7.952 19.648 8.089 19.936 8.212 20.222C8.447 20.77 8.967 21.812 9.262 22.328L9.437 22.635L9.884 22.747C10.648 22.938 11.164 23 11.995 23C12.906 23 13.642 22.902 14.371 22.685L14.588 22.62L14.805 22.229C15.286 21.36 15.621 20.668 15.959 19.85C16.127 19.444 16.462 19.189 16.864 19.161C16.981 19.153 17.247 19.174 17.508 19.211C18.239 19.318 19.651 19.429 20.262 19.429H20.458L20.936 18.946C21.736 18.137 22.244 17.374 22.637 16.394C22.784 16.028 22.99 15.353 22.99 15.239C22.99 15.122 22.029 13.768 21.461 13.085C20.905 12.415 20.876 12.362 20.877 12.008C20.877 11.724 20.962 11.563 21.354 11.097C21.751 10.624 22.311 9.874 22.707 9.284L23 8.847L22.961 8.67C22.857 8.193 22.555 7.395 22.296 6.913C22.112 6.569 21.762 6.037 21.519 5.732C21.293 5.448 20.848 4.98 20.594 4.759L20.418 4.606L19.705 4.641C18.881 4.681 18.162 4.743 17.554 4.828C16.783 4.936 16.546 4.896 16.234 4.602C16.08 4.457 16.047 4.398 15.837 3.909C15.559 3.263 15.228 2.589 14.859 1.92L14.584 1.422L14.415 1.372C14.053 1.266 13.555 1.149 13.189 1.083C12.699 0.996 11.593 0.972 11.13 1.037ZM12 8C9.791 8 8 9.791 8 12C8 14.209 9.791 16 12 16C14.209 16 16 14.209 16 12C16 9.791 14.209 8 12 8ZM12 9.5C13.381 9.5 14.5 10.619 14.5 12C14.5 13.381 13.381 14.5 12 14.5C10.619 14.5 9.5 13.381 9.5 12C9.5 10.619 10.619 9.5 12 9.5Z" fill="#707B73"/></svg>
                    <span className="text-[#181b18] text-base font-normal">Technical Settings</span>
                  </div>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ transform: techSettingsOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 300ms ease-in-out" }}><path fillRule="evenodd" clipRule="evenodd" d="M3.70083 6.72323C3.37466 6.86581 3.2364 7.29113 3.40825 7.62366C3.55749 7.91246 9.65328 14.1052 9.8324 14.1499C9.92172 14.1722 10.0678 14.1722 10.1571 14.1499C10.3362 14.1052 16.432 7.91246 16.5812 7.62366C16.7261 7.34347 16.6887 7.10203 16.4651 6.87259C16.3067 6.71015 16.2166 6.66666 16.0385 6.66666C15.819 6.66666 15.7288 6.75254 12.9034 9.64918L9.99415 12.6318L7.11463 9.67783C4.60089 7.09919 4.20907 6.72038 4.03031 6.69628C3.91767 6.68113 3.76943 6.69325 3.70083 6.72323Z" fill="#70707B"/></svg>
                </button>
                {techSettingsOpen && (
                  <div className="flex flex-col gap-4 pt-4">
                    {([
                      { key: "recordCalls", label: "Record Calls", desc: "", val: recordCalls, set: setRecordCalls },
                      { key: "checkFederalDNC", label: "Check US Federal Do Not Call (DNC) Registry", desc: "Block calls to numbers listed on the US Federal Do Not Call registry. Test calls are excluded from this check.", val: checkFederalDNC, set: setCheckFederalDNC },
                      { key: "enableLocalDNC", label: "Enable Account Do Not Call (DNC) List", desc: "Block calls to numbers on your account's own Do Not Call list.", val: enableLocalDNC, set: setEnableLocalDNC },
                      { key: "continueAfterCallLater", label: "Continue Dialing Attempts after \"Call Later\"", desc: "After a successful call to the contact, if the call was classified as Call Later, dialing attempts will continue.", val: continueAfterCallLater, set: setContinueAfterCallLater },
                      { key: "sensitiveContent", label: "Sensitive content restriction", desc: "Automatically detects sensitive data and hides the entire transcript from view. This ensures full PCI compliance.", val: sensitiveContent, set: setSensitiveContent },
                      { key: "allowDuplicates", label: "Allow Duplicate Phone Numbers", desc: "Allow having multiple contacts with the same phone number.", val: allowDuplicates, set: setAllowDuplicates },
                    ] as { key: string; label: string; desc: string; val: boolean; set: (v: boolean) => void }[]).map(({ key, label, desc, val, set }, i, arr) => (
                      <div key={key}>
                        <div className="w-full justify-between flex items-center gap-3">
                          <div>
                            <span className="text-zinc-900 text-base font-normal">{label}</span>
                            {desc && <div className="text-neutral-500 text-sm mt-0.5">{desc}</div>}
                          </div>
                          <div className="relative inline-flex items-center shrink-0">
                            <div onClick={() => set(!val)} className="relative w-[50px] h-7 flex items-center rounded-full transition-colors duration-300 cursor-pointer" style={{ backgroundColor: val ? "rgb(54,85,232)" : "rgb(244,245,244)" }}>
                              <div className={`absolute w-6 h-6 bg-white rounded-full shadow-md transform transition-transform duration-300 ${val ? "translate-x-6" : "translate-x-0.5"}`} />
                            </div>
                          </div>
                        </div>
                        {i < arr.length - 1 && <div className="w-full h-px bg-[#E4E7E5] mt-4" />}
                      </div>
                    ))}
                    <div className="w-full h-px bg-[#E4E7E5]" />
                    <div className="text-zinc-900 text-base font-normal mb-1">Limit the duration of the call</div>
                    <div className="relative w-full">
                      <input type="number" min="1" max="30" value={maxDuration} onChange={(e) => setMaxDuration(e.target.value)} placeholder=" "
                        className="peer h-auto w-full block pl-4 pb-2.5 pt-6 text-base text-black bg-[#00000005] focus:outline-none focus:ring-0 hover:bg-[#0000000A] caret-[#3655E8] rounded-2xl border border-[#00000014] hover:border-[#00000029] focus:border-[#3655E8] transition-colors"
                      />
                      <label className="absolute text-base font-normal text-[#00000066] duration-300 transform top-4 left-4 scale-75 -translate-y-3 pointer-events-none peer-placeholder-shown:scale-100 peer-placeholder-shown:translate-y-0 peer-focus:scale-75 peer-focus:-translate-y-3 peer-focus:text-[#3655E8]">Time In Minutes</label>
                    </div>
                  </div>
                )}
              </section>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── StepCard ──────────────────────────────────────────────────────────────

interface StepCardProps {
  step: ScriptStep;
  idx: number;
  isActive: boolean;
  cfg: { label: string; color: string; placeholder: string };
  onToggle: () => void;
  onUpdate: (patch: Partial<ScriptStep>) => void;
  onDelete: () => void;
  canDelete: boolean;
  renderStepText: (text: string) => React.ReactNode;
}

function StepCard({ step, idx, isActive, cfg, onToggle, onUpdate, onDelete, canDelete, renderStepText }: StepCardProps) {
  const showIcons = step.type !== "sms" && step.type !== "call_transfer" && step.type !== "end_call";

  if (!isActive) {
    // Collapsed preview
    return (
      <div className="rounded-xl border border-gray-200 bg-white hover:border-gray-300 cursor-pointer transition-all px-4 py-3" onClick={onToggle}>
        <p className="text-xs font-medium mb-1" style={{ color: cfg.color }}>
          {step.type === "step" ? `Step ${idx + 1}` : cfg.label}
        </p>
        {step.type === "end_call" ? (
          <p className="text-sm text-gray-500 italic">End of call</p>
        ) : (
          <div className="flex items-center gap-1 flex-wrap text-sm text-gray-700">
            {step.text ? renderStepText(step.text) : <span className="text-gray-400 italic text-xs">{cfg.placeholder}</span>}
          </div>
        )}
      </div>
    );
  }

  // Expanded
  return (
    <div className="rounded-xl border-2 border-[#4F46E5] overflow-hidden" style={{ borderColor: cfg.color }}>
      {/* Main input area */}
      {step.type !== "end_call" && (
        <div className="bg-[#FAFBFF]" style={{ background: cfg.color === "#B45309" ? "#FFFBEB" : "#FAFBFF" }}>
          <div className="px-4 pt-3">
            <p className="text-xs font-semibold mb-2" style={{ color: cfg.color }}>
              {step.type === "step" ? `Step ${idx + 1}` : cfg.label}
            </p>
            <textarea
              autoFocus
              value={step.text}
              onChange={(e) => onUpdate({ text: e.target.value })}
              placeholder={cfg.placeholder}
              className="w-full bg-transparent text-sm resize-none outline-none min-h-[80px] placeholder-gray-300"
              style={{ color: cfg.color === "#B45309" ? "#92400E" : "#1F2937" }}
              rows={4}
            />
          </div>
          {/* Toolbar */}
          <div className="px-4 pb-3 pt-2 border-t flex items-center justify-between" style={{ borderColor: cfg.color === "#B45309" ? "#FDE68A" : "#E8EAFF" }}>
            <div className="flex items-center gap-3">
              <button className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M12 2.25C6.615 2.25 2.25 6.615 2.25 12C2.25 17.385 6.615 21.75 12 21.75C17.385 21.75 21.75 17.385 21.75 12C21.75 6.615 17.385 2.25 12 2.25ZM12.75 8.25C12.75 7.836 12.414 7.5 12 7.5C11.586 7.5 11.25 7.836 11.25 8.25V11.25H8.25C7.836 11.25 7.5 11.586 7.5 12C7.5 12.414 7.836 12.75 8.25 12.75H11.25V15.75C11.25 16.164 11.586 16.5 12 16.5C12.414 16.5 12.75 16.164 12.75 15.75V12.75H15.75C16.164 12.75 16.5 12.414 16.5 12C16.5 11.586 16.164 11.25 15.75 11.25H12.75V8.25Z" fill="currentColor"/></svg>
                Add Variable
              </button>
              {step.type !== "action" && step.type !== "call_transfer" && (
                <button className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M4.25 5C4.25 4.586 4.586 4.25 5 4.25H14C14.414 4.25 14.75 4.586 14.75 5C14.75 5.414 14.414 5.75 14 5.75H5.75V18.25H18.25V10C18.25 9.586 18.586 9.25 19 9.25C19.414 9.25 19.75 9.586 19.75 10V19C19.75 19.414 19.414 19.75 19 19.75H5C4.586 19.75 4.25 19.414 4.25 19V5Z" fill="currentColor"/></svg>
                  Add Instruction
                </button>
              )}
            </div>
            <div className="flex items-center gap-0.5">
              {showIcons && <Btn onClick={() => {}}><CopyIcon size={13} /></Btn>}
              <Btn onClick={() => {}}><SlidersIcon size={13} /></Btn>
              {showIcons && <Btn onClick={() => {}}><SoundIcon size={13} /></Btn>}
              {showIcons && <Btn onClick={() => {}}><SparkleIcon size={13} /></Btn>}
              <Btn onClick={() => { if (canDelete) onDelete(); }} className={canDelete ? "hover:text-red-500" : "opacity-30 cursor-not-allowed"}>
                <TrashIcon size={13} />
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── Type-specific sub-sections ── */}

      {step.type === "schedule_meeting" && (
        <div className="border-t border-gray-100 bg-white">
          <div className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold bg-black text-white rounded px-1.5 py-0.5">Cal.com</span>
              <span className="text-sm font-medium text-gray-800">{step.meetingService || "Meeting"}</span>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-gray-400"><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </div>
          <div className="px-4 pb-3">
            <p className="text-xs text-gray-400 leading-relaxed">Time slots are offered in the contact's timezone: provided at creation, otherwise inferred from the phone number, and if neither exists, the campaign timezone is used.</p>
          </div>
        </div>
      )}

      {step.type === "sms" && (
        <div className="border-t border-gray-100 bg-white">
          <div className="px-4 py-3">
            <textarea
              value={step.smsTemplate ?? ""}
              onChange={(e) => onUpdate({ smsTemplate: e.target.value })}
              placeholder="SMS Template"
              className="w-full bg-transparent text-sm text-gray-700 resize-none outline-none min-h-[60px] placeholder-gray-300"
              rows={3}
            />
          </div>
        </div>
      )}

      {step.type === "action" && (
        <div className="border-t border-gray-100 bg-white">
          <button className="w-full px-4 py-3 flex items-center gap-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-gray-500">
              <path fillRule="evenodd" clipRule="evenodd" d="M21.5 4.5C21.5 5.605 20.605 6.5 19.5 6.5C18.395 6.5 17.5 5.605 17.5 4.5C17.5 3.395 18.395 2.5 19.5 2.5C20.605 2.5 21.5 3.395 21.5 4.5ZM23 4.5C23 6.433 21.433 8 19.5 8C18.943 8 18.417 7.87 17.95 7.639L14.443 12.022L17.699 16.498C18.225 16.182 18.841 16 19.5 16C21.433 16 23 17.567 23 19.5C23 21.433 21.433 23 19.5 23C17.567 23 16 21.433 16 19.5C16 18.773 16.222 18.098 16.601 17.539L13.118 12.75H7.919C7.576 14.323 6.176 15.5 4.5 15.5C2.567 15.5 1 13.933 1 12C1 10.067 2.567 8.5 4.5 8.5C6.176 8.5 7.576 9.677 7.919 11.25H13.14L16.779 6.701C16.292 6.1 16 5.334 16 4.5C16 2.567 17.567 1 19.5 1C21.433 1 23 2.567 23 4.5ZM6.5 12C6.5 13.105 5.605 14 4.5 14C3.395 14 2.5 13.105 2.5 12C2.5 10.895 3.395 10 4.5 10C5.605 10 6.5 10.895 6.5 12ZM19.5 21.5C20.605 21.5 21.5 20.605 21.5 19.5C21.5 18.395 20.605 17.5 19.5 17.5C18.395 17.5 17.5 18.395 17.5 19.5C17.5 20.605 18.395 21.5 19.5 21.5Z" fill="currentColor" />
            </svg>
            <span className="font-medium">Choose action</span>
          </button>
        </div>
      )}

      {step.type === "call_transfer" && (
        <div className="border-t border-gray-100 bg-white divide-y divide-gray-100">
          {/* Phone input */}
          <div className="px-4 py-3 flex items-center gap-3">
            <span className="text-xs font-bold text-gray-700 bg-gray-100 rounded px-1.5 py-0.5 shrink-0">PH</span>
            <input
              type="text"
              value={step.transferPhone ?? ""}
              onChange={(e) => onUpdate({ transferPhone: e.target.value })}
              placeholder="International Phone Number or SIP URL"
              className="flex-1 text-sm bg-transparent outline-none text-gray-700 placeholder-gray-300"
            />
          </div>
          {/* Caller ID */}
          <div className="px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-gray-700">Caller ID for Forwarded Call</span>
            <div className="flex items-center gap-1.5 cursor-pointer text-gray-500 hover:text-gray-800">
              <span className="text-sm">{step.transferCallerId || "Campaign's number"}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
          </div>
          {/* Warm transfer toggle */}
          <div className="px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-gray-700">Warm Transfer</span>
            <button onClick={() => onUpdate({ warmTransfer: !step.warmTransfer })}
              className={`w-10 h-6 rounded-full transition-colors relative ${step.warmTransfer ? "bg-[#4F46E5]" : "bg-gray-200"}`}>
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${step.warmTransfer ? "translate-x-5" : "translate-x-1"}`} />
            </button>
          </div>
          {/* Delete toolbar */}
          <div className="px-4 py-2 flex items-center justify-between">
            <button className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M12 2.25C6.615 2.25 2.25 6.615 2.25 12C2.25 17.385 6.615 21.75 12 21.75C17.385 21.75 21.75 17.385 21.75 12C21.75 6.615 17.385 2.25 12 2.25ZM12.75 8.25C12.75 7.836 12.414 7.5 12 7.5C11.586 7.5 11.25 7.836 11.25 8.25V11.25H8.25C7.836 11.25 7.5 11.586 7.5 12C7.5 12.414 7.836 12.75 8.25 12.75H11.25V15.75C11.25 16.164 11.586 16.5 12 16.5C12.414 16.5 12.75 16.164 12.75 15.75V12.75H15.75C16.164 12.75 16.5 12.414 16.5 12C16.5 11.586 16.164 11.25 15.75 11.25H12.75V8.25Z" fill="currentColor"/></svg>
              Add Variable
            </button>
            <div className="flex items-center gap-0.5">
              <Btn onClick={() => {}}><SlidersIcon size={13} /></Btn>
              <Btn onClick={() => { if (canDelete) onDelete(); }} className={canDelete ? "hover:text-red-500" : "opacity-30 cursor-not-allowed"}>
                <TrashIcon size={13} />
              </Btn>
            </div>
          </div>
        </div>
      )}

      {step.type === "end_call" && (
        <div className="bg-white px-4 py-5 flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-red-500">
              <path fillRule="evenodd" clipRule="evenodd" d="M1.08 5.285C1.444 3.049 2.804 1.539 4.848 1.103C6.043 0.849 7.069 1.066 7.846 1.74C8.174 2.024 9.496 3.596 9.788 4.05C10.27 4.797 10.463 5.858 10.282 6.756C10.127 7.523 9.899 7.931 8.823 9.373C8.28 10.1 7.837 10.736 7.837 10.785C7.838 10.912 8.349 11.96 8.611 12.374C9.008 12.999 9.54 13.64 10.129 14.202C10.682 14.729 11.578 15.4 11.728 15.4C11.767 15.4 12.478 15.053 13.308 14.629C14.97 13.781 15.294 13.671 16.128 13.671C17.095 13.671 18.003 14.035 18.701 14.703C19.283 15.261 20.456 16.701 20.655 17.102C21.159 18.119 21.112 19.152 20.506 20.388C19.906 21.609 18.84 22.483 17.519 22.836C16.933 22.993 15.763 23.048 15.048 22.954C12.85 22.663 10.427 21.485 8.066 19.561C7.174 18.834 5.481 17.103 4.866 16.289C2.747 13.485 1.383 10.444 1.057 7.793C0.972 7.097 0.984 5.891 1.08 5.285Z" fill="currentColor" />
            </svg>
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold text-red-600">End Call</p>
            <p className="text-xs text-gray-400 mt-0.5">The call will end at this point</p>
          </div>
          {canDelete && (
            <button onClick={onDelete} className="text-xs text-gray-400 hover:text-red-500 flex items-center gap-1 transition-colors">
              <TrashIcon size={12} /> Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Btn({ onClick, children, className = "" }: { onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <button onClick={onClick} className={`w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors ${className}`}>
      {children}
    </button>
  );
}

// ── Provider wrapper ───────────────────────────────────────────────────────

export default function CampaignEditor(props: Props) {
  return <ReactFlowProvider><CampaignEditorInner {...props} /></ReactFlowProvider>;
}

// ── Icons ──────────────────────────────────────────────────────────────────

function TabIcon({ tab }: { tab: Tab }) {
  if (tab === "Script") return <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M19.5 9C21.433 9 23 7.433 23 5.5C23 3.567 21.433 2 19.5 2C17.567 2 16 3.567 16 5.5C16 7.433 17.567 9 19.5 9ZM19.5 7.5C20.605 7.5 21.5 6.605 21.5 5.5C21.5 4.395 20.605 3.5 19.5 3.5C18.395 3.5 17.5 4.395 17.5 5.5C17.5 6.605 18.395 7.5 19.5 7.5Z" fill="currentColor"/><path fillRule="evenodd" clipRule="evenodd" d="M4.5 15.5C6.433 15.5 8 13.933 8 12C8 10.067 6.433 8.5 4.5 8.5C2.567 8.5 1 10.067 1 12C1 13.933 2.567 15.5 4.5 15.5ZM4.5 14C5.605 14 6.5 13.105 6.5 12C6.5 10.895 5.605 10 4.5 10C3.395 10 2.5 10.895 2.5 12C2.5 13.105 3.395 14 4.5 14Z" fill="currentColor"/><path fillRule="evenodd" clipRule="evenodd" d="M23 18.5C23 20.433 21.433 22 19.5 22C17.567 22 16 20.433 16 18.5C16 16.567 17.567 15 19.5 15C21.433 15 23 16.567 23 18.5ZM21.5 18.5C21.5 19.605 20.605 20.5 19.5 20.5C18.395 20.5 17.5 19.605 17.5 18.5C17.5 17.395 18.395 16.5 19.5 16.5C20.605 16.5 21.5 17.395 21.5 18.5Z" fill="currentColor"/><path d="M14 6.25C13.31 6.25 12.75 6.81 12.75 7.5V10C12.75 10.788 12.419 11.499 11.888 12C12.419 12.501 12.75 13.212 12.75 14V16.5C12.75 17.19 13.31 17.75 14 17.75C14.414 17.75 14.75 18.086 14.75 18.5C14.75 18.914 14.414 19.25 14 19.25C12.481 19.25 11.25 18.019 11.25 16.5V14C11.25 13.31 10.69 12.75 10 12.75C9.586 12.75 9.25 12.414 9.25 12C9.25 11.586 9.586 11.25 10 11.25C10.69 11.25 11.25 10.69 11.25 10V7.5C11.25 5.981 12.481 4.75 14 4.75C14.414 4.75 14.75 5.086 14.75 5.5C14.75 5.914 14.414 6.25 14 6.25Z" fill="currentColor"/></svg>;
  if (tab === "Scenarios") return <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M4.96 15.41L5.25 14.48L4.52 13.84C3.242 12.716 2.5 11.21 2.5 9.59C2.5 6.398 5.498 3.5 9.602 3.5C13.707 3.5 16.705 6.398 16.705 9.59C16.705 12.783 13.707 15.681 9.602 15.681C8.916 15.681 8.256 15.597 7.633 15.443L7.025 15.292L6.49 15.619C6.257 15.753 5.957 15.933 5.625 16.123C5.182 16.37 4.724 16.603 4.691 16.379C4.76 16.121 4.819 15.908 4.862 15.754L4.96 15.41ZM3.024 18.699C3.707 19.076 7.272 16.899 7.272 16.899C8.013 17.083 8.795 17.181 9.602 17.181C14.353 17.181 18.205 13.782 18.205 9.59C18.205 5.398 14.353 2 9.602 2C4.851 2 1 5.398 1 9.59C1 11.691 1.967 13.593 3.53 14.967C3.53 14.967 2.473 18.395 3.024 18.699Z" fill="currentColor"/></svg>;
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M16.154 3.004C17.739 3.084 19 4.395 19 6V18C19 19.657 17.657 21 16 21H8C6.343 21 5 19.657 5 18V6C5 4.343 6.343 3 8 3H16L16.154 3.004ZM8 4.5C7.172 4.5 6.5 5.172 6.5 6V18C6.5 18.828 7.172 19.5 8 19.5H16C16.828 19.5 17.5 18.828 17.5 18V6C17.5 5.172 16.828 4.5 16 4.5H8Z" fill="currentColor"/><path d="M2 6.25C2.414 6.25 2.75 6.586 2.75 7V17C2.75 17.414 2.414 17.75 2 17.75C1.586 17.75 1.25 17.414 1.25 17V7C1.25 6.586 1.586 6.25 2 6.25Z" fill="currentColor"/><path d="M22 6.25C22.414 6.25 22.75 6.586 22.75 7V17C22.75 17.414 22.414 17.75 22 17.75C21.586 17.75 21.25 17.414 21.25 17V7C21.25 6.586 21.586 6.25 22 6.25Z" fill="currentColor"/></svg>;
}

function ShareIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M21.5 4.5C21.5 5.605 20.605 6.5 19.5 6.5C18.395 6.5 17.5 5.605 17.5 4.5C17.5 3.395 18.395 2.5 19.5 2.5C20.605 2.5 21.5 3.395 21.5 4.5ZM23 4.5C23 6.433 21.433 8 19.5 8C18.943 8 18.417 7.87 17.95 7.639L14.443 12.022L17.699 16.498C18.225 16.182 18.841 16 19.5 16C21.433 16 23 17.567 23 19.5C23 21.433 21.433 23 19.5 23C17.567 23 16 21.433 16 19.5C16 18.773 16.222 18.098 16.601 17.539L13.118 12.75H7.919C7.576 14.323 6.176 15.5 4.5 15.5C2.567 15.5 1 13.933 1 12C1 10.067 2.567 8.5 4.5 8.5C6.176 8.5 7.576 9.677 7.919 11.25H13.14L16.779 6.701C16.292 6.1 16 5.334 16 4.5C16 2.567 17.567 1 19.5 1C21.433 1 23 2.567 23 4.5ZM6.5 12C6.5 13.105 5.605 14 4.5 14C3.395 14 2.5 13.105 2.5 12C2.5 10.895 3.395 10 4.5 10C5.605 10 6.5 10.895 6.5 12ZM19.5 21.5C20.605 21.5 21.5 20.605 21.5 19.5C21.5 18.395 20.605 17.5 19.5 17.5C18.395 17.5 17.5 18.395 17.5 19.5C17.5 20.605 18.395 21.5 19.5 21.5Z" fill="currentColor"/></svg>; }
function PlusIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M12 3.75C12.414 3.75 12.75 4.086 12.75 4.5V11.25H19.5C19.914 11.25 20.25 11.586 20.25 12C20.25 12.414 19.914 12.75 19.5 12.75H12.75V19.5C12.75 19.914 12.414 20.25 12 20.25C11.586 20.25 11.25 19.914 11.25 19.5V12.75H4.5C4.086 12.75 3.75 12.414 3.75 12C3.75 11.586 4.086 11.25 4.5 11.25H11.25V4.5C11.25 4.086 11.586 3.75 12 3.75Z" fill="currentColor"/></svg>; }
function PhoneIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M1.08 5.285C1.444 3.049 2.804 1.539 4.848 1.103C6.043 0.849 7.069 1.066 7.846 1.74C8.174 2.024 9.496 3.596 9.788 4.05C10.27 4.797 10.463 5.858 10.282 6.756C10.127 7.523 9.899 7.931 8.823 9.373C8.28 10.1 7.837 10.736 7.837 10.785C7.838 10.912 8.349 11.96 8.611 12.374C9.008 12.999 9.54 13.64 10.129 14.202C10.682 14.729 11.578 15.4 11.728 15.4C11.767 15.4 12.478 15.053 13.308 14.629C14.97 13.781 15.294 13.671 16.128 13.671C17.095 13.671 18.003 14.035 18.701 14.703C19.283 15.261 20.456 16.701 20.655 17.102C21.159 18.119 21.112 19.152 20.506 20.388C19.906 21.609 18.84 22.483 17.519 22.836C16.933 22.993 15.763 23.048 15.048 22.954C12.85 22.663 10.427 21.485 8.066 19.561C7.174 18.834 5.481 17.103 4.866 16.289C2.747 13.485 1.383 10.444 1.057 7.793C0.972 7.097 0.984 5.891 1.08 5.285Z" fill="currentColor"/></svg>; }
function CalendarIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M7.212 2.526C7.212 2.098 6.864 1.75 6.435 1.75C6.006 1.75 5.659 2.098 5.659 2.526V3.821H3.847C2.275 3.821 1 5.095 1 6.668V17.538C1 19.111 2.275 20.385 3.847 20.385H8.506C8.935 20.385 9.282 20.038 9.282 19.609C9.282 19.18 8.935 18.833 8.506 18.833H3.847C3.132 18.833 2.553 18.253 2.553 17.538V6.668C2.553 5.953 3.132 5.374 3.847 5.374H5.659V6.668C5.659 7.096 6.006 7.444 6.435 7.444C6.864 7.444 7.212 7.096 7.212 6.668V2.526ZM15.494 2.526C15.494 2.098 15.147 1.75 14.718 1.75C14.289 1.75 13.941 2.098 13.941 2.526V3.821H9.024C8.595 3.821 8.247 4.168 8.247 4.597C8.247 5.026 8.595 5.374 9.024 5.374H13.941V6.668C13.941 7.096 14.289 7.444 14.718 7.444C15.147 7.444 15.494 7.096 15.494 6.668V2.526Z" fill="currentColor"/></svg>; }
function PersonIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M12 2.75C9.377 2.75 7.25 4.877 7.25 7.5C7.25 10.123 9.377 12.25 12 12.25C14.623 12.25 16.75 10.123 16.75 7.5C16.75 4.877 14.623 2.75 12 2.75ZM5.75 7.5C5.75 4.048 8.548 1.25 12 1.25C15.452 1.25 18.25 4.048 18.25 7.5C18.25 10.952 15.452 13.75 12 13.75C8.548 13.75 5.75 10.952 5.75 7.5ZM3.75 22.25C3.75 18.246 7.246 15 12 15C16.754 15 20.25 18.246 20.25 22.25C20.25 22.664 19.914 23 19.5 23C19.086 23 18.75 22.664 18.75 22.25C18.75 19.104 15.704 16.5 12 16.5C8.296 16.5 5.25 19.104 5.25 22.25C5.25 22.664 4.914 23 4.5 23C4.086 23 3.75 22.664 3.75 22.25Z" fill="currentColor"/></svg>; }
function SlidersIcon({ size = 20 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M3 5.25C2.586 5.25 2.25 5.586 2.25 6C2.25 6.414 2.586 6.75 3 6.75H7.25V7.5C7.25 7.914 7.586 8.25 8 8.25C8.414 8.25 8.75 7.914 8.75 7.5V6.75H21C21.414 6.75 21.75 6.414 21.75 6C21.75 5.586 21.414 5.25 21 5.25H8.75V4.5C8.75 4.086 8.414 3.75 8 3.75C7.586 3.75 7.25 4.086 7.25 4.5V5.25H3ZM3 11.25C2.586 11.25 2.25 11.586 2.25 12C2.25 12.414 2.586 12.75 3 12.75H15.25V13.5C15.25 13.914 15.586 14.25 16 14.25C16.414 14.25 16.75 13.914 16.75 13.5V12.75H21C21.414 12.75 21.75 12.414 21.75 12C21.75 11.586 21.414 11.25 21 11.25H16.75V10.5C16.75 10.086 16.414 9.75 16 9.75C15.586 9.75 15.25 10.086 15.25 10.5V11.25H3Z" fill="currentColor"/></svg>; }
function CopyIcon({ size = 20 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M7.25 4C7.25 3.586 7.586 3.25 8 3.25H20C20.414 3.25 20.75 3.586 20.75 4V16C20.75 16.414 20.414 16.75 20 16.75H16.75V20C16.75 20.414 16.414 20.75 16 20.75H4C3.586 20.75 3.25 20.414 3.25 20V8C3.25 7.586 3.586 7.25 4 7.25H7.25V4ZM8.75 7.25H16C16.414 7.25 16.75 7.586 16.75 8V15.25H19.25V4.75H8.75V7.25ZM4.75 8.75V19.25H15.25V8.75H4.75Z" fill="currentColor"/></svg>; }
function SoundIcon({ size = 20 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M11.026 3.096C11.364 3.247 11.583 3.583 11.583 3.952V20.048C11.583 20.417 11.364 20.753 11.026 20.904C10.689 21.055 10.295 20.995 10.019 20.75L5.201 16.429H2.381C1.619 16.429 1 15.81 1 15.048V8.952C1 8.19 1.619 7.571 2.381 7.571H5.201L10.019 3.25C10.295 3.005 10.689 2.945 11.026 3.096ZM10.202 5.476L6.22 9.037C6.045 9.194 5.818 9.286 5.581 9.286H2.714V14.714H5.581C5.818 14.714 6.045 14.806 6.22 14.963L10.202 18.524V5.476Z" fill="currentColor"/><path d="M14.503 7.757C14.835 7.426 15.372 7.426 15.704 7.757C17.432 9.486 17.432 12.272 15.704 14C15.372 14.332 14.835 14.332 14.503 14C14.171 13.668 14.171 13.131 14.503 12.799C15.564 11.739 15.564 9.999 14.503 8.938C14.171 8.606 14.171 8.069 14.503 7.757Z" fill="currentColor"/></svg>; }
function SparkleIcon({ size = 20 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M9 3L10.5 9H15L11 12L12.5 18L9 15L5.5 18L7 12L3 9H7.5L9 3Z" fill="currentColor"/><path d="M19 2L19.8 5H22L20.1 6.5L20.8 9.5L19 8L17.2 9.5L17.9 6.5L16 5H18.2L19 2Z" fill="currentColor"/></svg>; }
function TrashIcon({ size = 20 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M10.5 2.25C9.81 2.25 9.25 2.81 9.25 3.5V4.25H5C4.586 4.25 4.25 4.586 4.25 5C4.25 5.414 4.586 5.75 5 5.75H5.25V19C5.25 20.243 6.257 21.25 7.5 21.25H16.5C17.743 21.25 18.75 20.243 18.75 19V5.75H19C19.414 5.75 19.75 5.414 19.75 5C19.75 4.586 19.414 4.25 19 4.25H14.75V3.5C14.75 2.81 14.19 2.25 13.5 2.25H10.5ZM13.25 4.25V3.75H10.75V4.25H13.25ZM6.75 5.75H17.25V19C17.25 19.414 16.914 19.75 16.5 19.75H7.5C7.086 19.75 6.75 19.414 6.75 19V5.75ZM10 8.25C10.414 8.25 10.75 8.586 10.75 9V16C10.75 16.414 10.414 16.75 10 16.75C9.586 16.75 9.25 16.414 9.25 16V9C9.25 8.586 9.586 8.25 10 8.25ZM14 8.25C14.414 8.25 14.75 8.586 14.75 9V16C14.75 16.414 14.414 16.75 14 16.75C13.586 16.75 13.25 16.414 13.25 16V9C13.25 8.586 13.586 8.25 14 8.25Z" fill="currentColor"/></svg>; }
