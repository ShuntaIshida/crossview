export function renderStartScreen(container, onCreate, onOpen) {
  container.innerHTML = `
    <section class="screen start-screen">
      <article class="start-card">
        <h1 class="start-title">CrossView</h1>
        <p class="start-subtitle">複数Routeの比較分析を行うクライアントサイドWebアプリ</p>
        <div class="start-actions">
          <button id="newProjectBtn" class="primary-btn">新規プロジェクト</button>
          <button id="openProjectBtn" class="ghost-btn">プロジェクトを開く</button>
        </div>
        <form id="projectForm" class="project-form hidden">
          <div class="form-row">
            <label for="projectName">プロジェクト名</label>
            <input id="projectName" name="projectName" type="text" required maxlength="80" placeholder="CrossView" />
          </div>
          <div class="form-row">
            <label for="frameInterval">静止画抽出間隔</label>
            <select id="frameInterval" name="frameInterval">
              <option value="1">1秒</option>
              <option value="5" selected>5秒</option>
              <option value="10">10秒</option>
            </select>
          </div>
          <button type="submit" class="primary-btn">プロジェクトを作成</button>
        </form>
      </article>
    </section>
  `;

  const form = container.querySelector("#projectForm");
  const newButton = container.querySelector("#newProjectBtn");
  const openButton = container.querySelector("#openProjectBtn");

  newButton.addEventListener("click", () => {
    form.classList.remove("hidden");
  });

  openButton.addEventListener("click", () => {
    onOpen();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const name = String(formData.get("projectName") || "").trim();
    const frameIntervalSec = Number(formData.get("frameInterval") || 5);

    if (!name) {
      alert("プロジェクト名を入力してください。");
      return;
    }

    onCreate({ name, frameIntervalSec });
  });
}
