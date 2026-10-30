import { useState, useEffect, useCallback, useRef } from "react";
import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import { apiScopes, API_URL } from "./authConfig";
import "./App.css";

const TEMPLATE =
  "FirstName,LastName,Department,JobTitle,Manager\nJohn,Smith,IT,Engineer,Sarah Lee\n";

function StatusBadge({ status }) {
  return <span className={`badge ${status.toLowerCase()}`}>{status}</span>;
}

function batchState(b) {
  const open = b.total - b.success - b.failed;
  if (open > 0) return { label: open === b.pending ? "Pending" : "Processing", cls: "pending" };
  if (b.failed > 0) return { label: "Completed with errors", cls: "failed" };
  return { label: "Completed", cls: "success" };
}

export default function App() {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const [batches, setBatches] = useState([]);
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [errors, setErrors] = useState([]);
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [revealed, setRevealed] = useState(null);
  const fileInput = useRef(null);

  const login = () => instance.loginRedirect({ scopes: apiScopes });
  const logout = () => instance.logoutRedirect();

  const getToken = useCallback(async () => {
    const result = await instance.acquireTokenSilent({
      scopes: apiScopes,
      account: accounts[0],
    });
    return result.accessToken;
  }, [instance, accounts]);

  const loadBatches = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/batches`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setBatches(await res.json());
    } catch (e) {
      console.error(e);
    }
  }, [getToken]);

  const loadItems = useCallback(
    async (id) => {
      try {
        const token = await getToken();
        const res = await fetch(`${API_URL}/api/batches/${id}/items`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          setErrors([`Could not load details (${res.status})`]);
          return;
        }
        setItems(await res.json());
      } catch (e) {
        setErrors([e.message]);
      }
    },
    [getToken]
  );

  useEffect(() => {
    if (!isAuthenticated) return;
    loadBatches();
    const timer = setInterval(() => {
      loadBatches();
      if (selected) loadItems(selected);
    }, 5000);
    return () => clearInterval(timer);
  }, [isAuthenticated, selected, loadBatches, loadItems]);

  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => setInfo(""), 5000);
    return () => clearTimeout(t);
  }, [info]);

  const uploadFile = async (file) => {
    if (!file) return;
    setErrors([]);
    setInfo("");
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setErrors(["Please choose a .csv file"]);
      return;
    }
    setBusy(true);
    try {
      const token = await getToken();
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API_URL}/api/batches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors(data.errors || [`Upload failed (${res.status})`]);
        return;
      }
      setInfo(`Uploaded ${data.count} joiners from ${file.name}`);
      setRevealed(null);
      setSelected(data.id);
      setItems([]);
      loadItems(data.id);
      loadBatches();
    } catch (err) {
      setErrors([err.message]);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    uploadFile(e.dataTransfer.files[0]);
  };

  const onPick = (e) => {
    uploadFile(e.target.files[0]);
    e.target.value = "";
  };

  const reveal = async (item) => {
    const who = `${item.firstName} ${item.lastName}`;
    if (!window.confirm(`Show the temporary password for ${who}? It can be shown only once.`)) return;
    setErrors([]);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/items/${item.id}/reveal-password`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors([data.error || `Could not reveal password (${res.status})`]);
        return;
      }
      setRevealed({ name: who, ...data });
      loadItems(selected);
    } catch (e) {
      setErrors([e.message]);
    }
  };

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(revealed.password);
      setInfo("Password copied to clipboard");
    } catch {
      setErrors(["Could not copy automatically. Select the password and copy it by hand."]);
    }
  };

  const downloadTemplate = () => {
    const blob = new Blob([TEMPLATE], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "joiners-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const openBatch = (id) => {
    setRevealed(null);
    setSelected(id);
    setItems([]);
    loadItems(id);
  };

  const closeBatch = () => {
    setRevealed(null);
    setSelected(null);
  };

  const totals = batches.reduce(
    (t, b) => ({
      people: t.people + b.total,
      pending: t.pending + (b.total - b.success - b.failed),
      success: t.success + b.success,
      failed: t.failed + b.failed,
    }),
    { people: 0, pending: 0, success: 0, failed: 0 }
  );

  const selectedBatch = batches.find((b) => b.id === selected);
  const displayName = accounts[0]?.name || accounts[0]?.username || "";
  const initials = displayName
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <>
      <header className="topbar">
        <div className="brand">
          JML <span>Portal</span>
        </div>
        {isAuthenticated && (
          <div className="user-box">
            <div className="avatar">{initials}</div>
            <span>{accounts[0].username}</span>
            <button className="btn ghost" onClick={logout}>
              Sign out
            </button>
          </div>
        )}
      </header>

      <main className="container">
        {!isAuthenticated ? (
          <div className="card signin">
            <h1>Joiner, Mover, Leaver</h1>
            <p>Sign in with your work account to manage joiners.</p>
            <button className="btn large" onClick={login}>
              Sign in with Microsoft
            </button>
          </div>
        ) : (
          <>
            <div className="stats">
              <div className="stat">
                <div className="label">Total joiners</div>
                <div className="value">{totals.people}</div>
              </div>
              <div className="stat pending">
                <div className="label">In progress</div>
                <div className="value">{totals.pending}</div>
              </div>
              <div className="stat success">
                <div className="label">Created</div>
                <div className="value">{totals.success}</div>
              </div>
              <div className="stat failed">
                <div className="label">Failed</div>
                <div className="value">{totals.failed}</div>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Upload joiners</h2>
                <button className="btn secondary" onClick={downloadTemplate}>
                  Download CSV template
                </button>
              </div>
              <div
                className={`dropzone ${dragOver ? "over" : ""} ${busy ? "busy" : ""}`}
                onClick={() => fileInput.current.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
              >
                <div className="big">
                  {busy ? "Uploading..." : "Drag and drop your CSV here, or click to browse"}
                </div>
                <div className="muted">
                  Columns: FirstName, LastName, Department, JobTitle, Manager
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv"
                  onChange={onPick}
                  style={{ display: "none" }}
                />
              </div>
              {info && <div className="alert ok">{info}</div>}
              {errors.length > 0 && (
                <div className="alert err">
                  <strong>Problem:</strong>
                  <ul>
                    {errors.map((er, i) => (
                      <li key={i}>{er}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Upload history</h2>
                <span className="muted">Auto-refreshes every 5 seconds</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>File</th>
                      <th>Uploaded by</th>
                      <th>Uploaded at</th>
                      <th>Progress</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.length === 0 && (
                      <tr>
                        <td colSpan="6" className="empty">
                          No uploads yet. Upload a CSV above to get started.
                        </td>
                      </tr>
                    )}
                    {batches.map((b) => {
                      const state = batchState(b);
                      const done = b.success + b.failed;
                      const pct = b.total ? Math.round((done / b.total) * 100) : 0;
                      return (
                        <tr
                          key={b.id}
                          className={`clickable ${selected === b.id ? "active" : ""}`}
                          onClick={() => openBatch(b.id)}
                        >
                          <td>{b.id}</td>
                          <td>{b.fileName}</td>
                          <td>{b.uploadedBy}</td>
                          <td>{new Date(b.uploadedAt + "Z").toLocaleString()}</td>
                          <td style={{ minWidth: 140 }}>
                            <div className={`progress ${b.failed > 0 ? "has-fail" : ""}`}>
                              <div style={{ width: `${pct}%` }} />
                            </div>
                            <div className="counts">
                              {done}/{b.total} done
                              {b.failed > 0 ? `, ${b.failed} failed` : ""}
                            </div>
                          </td>
                          <td>
                            <span className={`badge ${state.cls}`}>{state.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {selected && (
              <div className="card">
                <div className="card-head">
                  <h2>
                    Batch {selected}
                    {selectedBatch ? ` - ${selectedBatch.fileName}` : ""}
                  </h2>
                  <button className="btn secondary" onClick={closeBatch}>
                    Close
                  </button>
                </div>

                {revealed && (
                  <div className="alert ok" style={{ marginBottom: 14 }}>
                    <strong>{revealed.name}</strong>: username{" "}
                    <code>{revealed.userPrincipalName}</code>, temporary password{" "}
                    <code>{revealed.password}</code>
                    <div style={{ marginTop: 8 }}>
                      <button className="btn secondary" onClick={copyPassword}>
                        Copy password
                      </button>{" "}
                      <button className="btn secondary" onClick={() => setRevealed(null)}>
                        Hide
                      </button>
                      <div className="muted" style={{ marginTop: 6 }}>
                        Shown once only. Share it securely. The user must change it at first
                        sign-in.
                      </div>
                    </div>
                  </div>
                )}

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Department</th>
                        <th>Job title</th>
                        <th>Manager</th>
                        <th>Username</th>
                        <th>Status</th>
                        <th>Password</th>
                        <th>Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.length === 0 && (
                        <tr>
                          <td colSpan="8" className="empty">
                            Loading...
                          </td>
                        </tr>
                      )}
                      {items.map((i) => (
                        <tr key={i.id}>
                          <td>
                            {i.firstName} {i.lastName}
                          </td>
                          <td>{i.department}</td>
                          <td>{i.jobTitle}</td>
                          <td>{i.manager}</td>
                          <td>{i.samAccountName}</td>
                          <td>
                            <StatusBadge status={i.status} />
                          </td>
                          <td>
                            {i.hasPassword ? (
                              <button className="btn secondary" onClick={() => reveal(i)}>
                                Reveal once
                              </button>
                            ) : i.passwordRevealedBy ? (
                              <span className="muted">Collected</span>
                            ) : null}
                          </td>
                          <td className="errtext">{i.errorMessage}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}