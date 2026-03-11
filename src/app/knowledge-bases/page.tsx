"use client";

import { useState } from "react";
import { Plus, X, Trash2 } from "lucide-react";

interface KnowledgeBase {
  id: number;
  name: string;
  dataSources: number;
  dateOfCreation: string;
}

const initialKnowledgeBases: KnowledgeBase[] = [
  { id: 1, name: "Lucky 7 RND campaign", dataSources: 10, dateOfCreation: "Nov 6, 2025" },
  { id: 2, name: "Lucky7even (FAQ / Objection Handling)", dataSources: 0, dateOfCreation: "Nov 11, 2025" },
  { id: 3, name: "Test", dataSources: 0, dateOfCreation: "Feb 4, 2026" },
];

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function KnowledgeBasesPage() {
  const [items, setItems] = useState<KnowledgeBase[]>(initialKnowledgeBases);
  const [showModal, setShowModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  function handleCreate() {
    if (!newName.trim()) return;
    setItems((prev) => [
      { id: prev.length + 1, name: newName.trim(), dataSources: 0, dateOfCreation: formatDate(new Date()) },
      ...prev,
    ]);
    setNewName("");
    setShowModal(false);
  }

  function handleDelete(id: number) {
    setItems((prev) => prev.filter((item) => item.id !== id));
    setDeleteConfirmId(null);
  }

  const deleteTarget = items.find((i) => i.id === deleteConfirmId);

  return (
    <div className="p-4 sm:p-6 w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Knowledge Bases</h1>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-full transition-colors"
        >
          <Plus size={15} />
          <span className="hidden sm:inline">Create New</span>
          <span className="sm:hidden">New</span>
        </button>
      </div>
      <div className="border-b border-gray-200 mb-4 sm:mb-5" />

      {/* ── Mobile card list (< sm) ── */}
      <div className="sm:hidden space-y-3">
        {items.length === 0 && (
          <p className="text-gray-400 text-sm text-center py-12">No knowledge bases yet.</p>
        )}
        {items.map((item) => (
          <div key={item.id} className="bg-white border border-gray-200 rounded-xl p-4 cursor-pointer hover:bg-gray-50 transition-colors">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-gray-900 text-sm mb-2">{item.name}</p>
              <button
                onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(item.id); }}
                className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors flex-shrink-0"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>{item.dataSources} data source{item.dataSources !== 1 ? "s" : ""}</span>
              <span>{item.dateOfCreation}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Desktop table (≥ sm) ── */}
      <div className="hidden sm:block bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left px-4 sm:px-6 py-3 text-xs font-medium text-gray-400 w-1/2">
                Knowledge Base
              </th>
              <th className="text-center px-4 sm:px-6 py-3 text-xs font-medium text-gray-400">
                Data Sources
              </th>
              <th className="text-center px-4 sm:px-6 py-3 text-xs font-medium text-gray-400">
                Date of Creation
              </th>
              <th className="w-14" />
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr
                key={item.id}
                className={`hover:bg-gray-50 transition-colors cursor-pointer group ${
                  index < items.length - 1 ? "border-b border-gray-100" : ""
                }`}
              >
                <td className="px-4 sm:px-6 py-4 text-left">
                  <span className="font-semibold text-gray-900">{item.name}</span>
                </td>
                <td className="px-4 sm:px-6 py-4 text-center text-gray-500">{item.dataSources}</td>
                <td className="px-4 sm:px-6 py-4 text-center text-gray-400">{item.dateOfCreation}</td>
                <td className="px-4 py-4 text-center">
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(item.id); }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-6 py-16 text-center text-gray-400 text-sm">
                  No knowledge bases yet. Create one to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-gray-900">Create and save</h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600 transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="mb-6">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="Name"
                autoFocus
                className="w-full px-4 py-2.5 border-2 border-blue-500 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none"
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 px-4 py-2.5 border border-gray-200 rounded-full text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                className="flex-1 px-4 py-2.5 rounded-full text-sm font-medium transition-colors disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-700 text-white"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirmId && deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center">
            <h2 className="text-base font-semibold text-gray-900 mb-2">
              Are you sure you want to delete the knowledge base?
            </h2>
            <p className="text-sm text-gray-400 mb-6 leading-relaxed">
              This action will remove all associated information permanently. This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="flex-1 px-4 py-2.5 border border-gray-200 rounded-full text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirmId)}
                className="flex-1 px-4 py-2.5 bg-red-500 hover:bg-red-600 text-white rounded-full text-sm font-medium transition-colors"
              >
                Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
