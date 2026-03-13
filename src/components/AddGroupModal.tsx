"use client";

import { useState } from "react";
import { X } from "lucide-react";

interface Props {
  onClose: () => void;
  onAdd: (name: string) => void;
}

export default function AddGroupModal({ onClose, onAdd }: Props) {
  const [name, setName] = useState("");

  function handleSave() {
    if (!name.trim()) return;
    onAdd(name.trim());
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-[var(--text-1)]">Create Group</h2>
          <button onClick={onClose} className="p-1 text-[var(--text-2)] hover:text-[var(--text-1)] rounded-lg hover:bg-[var(--bg-elevated)] transition-colors">
            <X size={18} />
          </button>
        </div>
        <div className="mb-6">
          <input type="text" value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder="Group name"
            autoFocus
            className="w-full px-4 py-2.5 bg-[var(--bg-app)] border-2 border-blue-500 rounded-xl text-sm text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none"
          />
        </div>
        <div className="flex gap-3">
          <button onClick={onClose}
            className="flex-1 px-4 py-2.5 border border-[var(--border)] rounded-full text-sm font-medium text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={!name.trim()}
            className="flex-1 px-4 py-2.5 rounded-full text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-600/20">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
