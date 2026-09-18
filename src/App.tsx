import { createContext, useContext, useEffect, useState } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { checkLocalApi } from './lib/api';
import { Trainer } from './pages/Trainer';
import { Progress } from './pages/Progress';
import { AdminHome } from './pages/AdminHome';
import { AdminGame } from './pages/AdminGame';

/** null while we are still probing for the local admin API. */
const LocalApiContext = createContext<boolean | null>(null);
export const useLocalApi = () => useContext(LocalApiContext);

export function App() {
  const [local, setLocal] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    checkLocalApi().then((ok) => alive && setLocal(ok));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <LocalApiContext.Provider value={local}>
      <HashRouter>
        <div className="app">
          <header className="topbar">
            <NavLink to="/" className="brand">
              <span className="brand-mark">♞</span>
              <span>Mistake Trainer</span>
            </NavLink>
            <nav className="tabs">
              <NavLink to="/" end className="tab">Train</NavLink>
              <NavLink to="/progress" className="tab">Progress</NavLink>
              {local && <NavLink to="/admin" className="tab">Admin</NavLink>}
            </nav>
            <span className={`mode-pill ${local ? 'is-local' : 'is-public'}`}>
              {local === null ? 'connecting…' : local ? 'local' : 'published set'}
            </span>
          </header>

          <main className="main">
            <Routes>
              <Route path="/" element={<Trainer />} />
              <Route path="/progress" element={<Progress />} />
              <Route path="/admin" element={local ? <AdminHome /> : <Navigate to="/" replace />} />
              <Route path="/admin/game/:id" element={local ? <AdminGame /> : <Navigate to="/" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </HashRouter>
    </LocalApiContext.Provider>
  );
}
