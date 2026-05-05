import { Navigate, Route, Routes } from "react-router-dom";
import { Workspace } from "./routes/Workspace";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Workspace />} />
      <Route path="/settings" element={<Workspace />} />
      <Route path="/worktree" element={<Workspace />} />
      <Route path="/workspace" element={<Navigate to="/worktree" replace />} />
      <Route path="/dashboard" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
