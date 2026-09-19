const status = document.getElementById("status")!;

fetch("/api/health")
  .then((r) => r.json())
  .then(
    (body: { status: string }) => (status.textContent = `api: ${body.status}`),
  )
  .catch(() => (status.textContent = "api: unreachable"));
