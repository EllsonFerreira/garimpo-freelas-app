// Garimpo Freelas — app do celular (PWA, sem build).
// Lê dados/oportunidades.json e dados/status.json do repositório privado via API do GitHub.
// Grava em dados/status.json: status de cada projeto e o controle financeiro (campo "fin").
// Em localhost sem token, lê os arquivos locais e grava no navegador.

const ARQ_OPORT = "dados/oportunidades.json";
const ARQ_STATUS = "dados/status.json";
const ARQ_META = "dados/meta.json";   // situação das contas (perfil aprovado, conexões/semana)
const PADRAO = { owner: "EllsonFerreira", repo: "garimpo-freelas", token: "" };

const STATUS = [
  ["novo", "Novos"],
  ["proposta_enviada", "Proposta enviada"],
  ["aceito", "Aceitos"],
  ["em_execucao", "Em execução"],
  ["entregue", "Entregues"],
  ["ignorado", "Ignorados"],
];
const NOME_STATUS = Object.fromEntries(STATUS);
const COM_FINANCEIRO = new Set(["aceito", "em_execucao", "entregue"]);

const $ = (s) => document.querySelector(s);
const estado = { projetos: [], status: {}, meta: {}, aba: "novo", busca: "", filtros: {}, carregando: false, tela: "oportunidades" };

// ---------- armazenamento local (protegido: pode falhar em modo privado) ----------
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const ler = (k, padrao) => { try { return JSON.parse(localStorage.getItem(k)) ?? padrao; } catch { return padrao; } };

const config = () => ({ ...PADRAO, ...ler("garimpo.config", {}) });
const taxas = () => ({ "99freelas": "", workana: "", ...ler("garimpo.taxas", {}) });
const modoLocal = () => !config().token && ["localhost", "127.0.0.1"].includes(location.hostname);

// ---------- formatação ----------
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const BRL2 = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const reais = (v) => (v == null || isNaN(v) ? "—" : (Math.abs(v) < 100 && v % 1 ? BRL2 : BRL).format(v));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hoje = () => new Date().toISOString().slice(0, 10);
const dataBR = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");
// "1.200,50" e "1200,5" (formato BR) ou "1200.5" (ponto decimal) -> número
const numero = (s) => {
  let t = String(s ?? "").replace(/[^\d.,-]/g, "");
  t = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : /^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, "") : t;
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
};

function valorTexto(p) {
  const a = p.valor_min_brl, b = p.valor_max_brl;
  if (a != null && b != null) return a === b ? reais(a) : `${reais(a)} – ${reais(b)}`;
  if (b != null) return `até ${reais(b)}`;
  if (a != null) return `acima de ${reais(a)}`;
  const orc = (p.orcamento || "").trim();
  if (/hora/i.test(orc)) return orc;
  // Só valores reais aqui; a estimativa aparece no detalhe (htmlEstimativa).
  const min = p.valor_minimo ? ` · lance mín. ${reais(p.valor_minimo)}` : "";
  if (/aberto/i.test(orc)) return `Orçamento aberto${min}`;
  return orc ? orc + min : "Valor não informado";
}

function htmlEstimativa(p) {
  if (!p.valor_estimado_brl || p.valor_sugerido) return "";   // a proposta já tem o valor que vale
  return `
    <div class="estimativa">
      <div><strong>Estimativa: ~${reais(p.valor_estimado_brl)}</strong> <span class="ajuda">(o cliente não informou orçamento)</span></div>
      <div class="ajuda">${esc(p.calculo_estimativa || "")}</div>
      <div class="ajuda">É só uma referência automática, usada nos filtros de valor. O valor para cobrar é o da proposta.</div>
    </div>`;
}

function partesProposta(txt) {
  if (!txt) return { cabecalho: "", corpo: "" };
  const i = txt.search(/^##\s*Proposta.*$/m);
  if (i < 0) return { cabecalho: "", corpo: txt.trim() };
  const corpo = txt.slice(i).replace(/^##.*\n/, "").trim();
  const cabecalho = txt.slice(0, i).split("\n").filter((l) => l.trim() && !l.startsWith("# ") && !/^Link:/i.test(l)).join("\n");
  return { cabecalho, corpo };
}

// ---------- proposta pelo Claude do celular ----------
// "Gerar proposta" copia um pedido completo (perfil + regras + projeto) para colar no app do
// Claude; a resposta é colada de volta e fica no status.json (campo proposta).
const valorDoTexto = (txt) => numero((txt || "").match(/Valor sugerido:\s*R\$\s*([\d.,]+)/i)?.[1]);

function aplicarPropostasDoApp() {
  for (const p of estado.projetos) {
    const r = estado.status[p.chave];
    if (r?.proposta) Object.assign(p, { proposta: r.proposta, valor_sugerido: r.valor_sugerido ?? null });
  }
}

function montarPedido(p) {
  const f = estado.meta?.perfil || {};
  const lista = (a) => (a && a.length ? a.join(", ") : "—");
  const minimo = p.valor_minimo ? `\nValor mínimo aceito pela plataforma: ${reais(p.valor_minimo)}` : "";
  const estim = p.valor_min_brl == null && p.valor_max_brl == null && p.valor_estimado_brl
    ? `\nEstimativa automática (referência fraca): ${reais(p.valor_estimado_brl)} — ${p.calculo_estimativa || ""}` : "";
  const taxa = p.plataforma === "99freelas"
    ? 'No 99Freelas o valor sugerido é o campo "Sua oferta" (o que eu recebo); o cliente vê um valor maior, com a taxa da plataforma. Por isso NÃO escreva valores em reais no texto da proposta (pode dizer a unidade, ex.: "o valor é por lote").'
    : "Não repita o valor em reais no texto da proposta; ele vai no campo de valor da plataforma.";
  return `Escreva uma proposta para o projeto freelancer abaixo, seguindo as regras e o formato de resposta.

## Meu perfil
Nome: ${f.nome || ""}
Título: ${f.titulo || ""}
Resumo: ${(f.resumo || "").trim().replace(/\s+/g, " ")}
Domino (pode citar como experiência): ${lista(f.domina)}
Conhecimento básico (citar só como conhecimento, nunca como especialidade): ${lista(f.conhece)}
NÃO domino (nunca afirmar experiência nisso; falar só do resultado entregue, ex.: "entrego a automação pronta e documentada"): ${lista(f.nao_domina)}
Valor da minha hora: ${reais(f.valor_hora_brl || 45)}
Como trabalho: executo com apoio de ferramentas (código, planilhas, SQL, automações, textos, dados), valido e entrego. Tarefas manuais (ligações, captcha, acesso a sistemas do cliente) são feitas por mim.

## Projeto
Plataforma: ${p.plataforma}
Título: ${p.titulo}
Link: ${p.url}
Categoria: ${p.categoria || "—"}${p.nivel ? ` · ${p.nivel}` : ""}
Orçamento do cliente: ${valorTexto(p)}${minimo}${estim}
Propostas já enviadas: ${p.propostas ?? "?"}
Publicado: ${idade(p.publicado_em)}
${p.habilidades?.length ? `Habilidades pedidas: ${p.habilidades.join(", ")}\n` : ""}Descrição completa:
${p.descricao || "—"}

## Regras
1. Antes de tudo, avalie se vale gastar uma proposta (tenho poucas): dá para entregar com qualidade? combina com meu perfil sem exagerar experiência? escopo e prazo viáveis? valor justo? Se não valer, diga "NÃO ENVIAR" e por quê, e mesmo assim escreva a proposta.
2. Texto da proposta: 80 a 150 palavras, em português, texto simples (sem negrito, títulos ou emojis). Comece respondendo ao problema do cliente (nunca "Olá, sou..."), explique em 2 ou 3 passos como vou resolver, cite experiência real só do que eu domino, informe o prazo e termine com uma pergunta que puxe conversa.
3. Proibido: mencionar IA, passar contatos externos (e-mail, telefone, WhatsApp, links), inventar experiência, portfólio ou resultados, prometer o que não dá para cumprir.
4. Valor sugerido = horas que EU gastaria (não o tempo de uma IA) × meu valor/hora, ajustado ao orçamento do cliente e ao valor mínimo da plataforma. ${taxa}
5. Se o cliente exigir experiência comprovada, portfólio ou entrevista técnica numa tecnologia que não domino, ou algo que só eu posso fazer (ligação, acesso a servidor), diga em "Riscos".

## Responda EXATAMENTE neste formato
Recomendação: ENVIAR ou NÃO ENVIAR — <motivo em uma linha>
Valor sugerido: R$ <número> | Prazo sugerido: <N> dias
Por que vale: <1 a 2 linhas>
Riscos/o que depende de mim: <...>

## Proposta (copiar e colar)
<texto da proposta>`;
}

async function gerarProposta(p) {
  const pedido = montarPedido(p);
  try {
    await navigator.clipboard.writeText(pedido);
  } catch {
    // sem permissão de área de transferência: mostra o pedido para copiar à mão
    const caixa = $("#pedido-manual");
    if (caixa) { caixa.hidden = false; caixa.querySelector("textarea").value = pedido; }
    aviso("Copie o pedido na caixa abaixo", 4000);
    return;
  }
  aviso("Pedido copiado — cole no Claude e envie", 4000);
  window.open("https://claude.ai/new", "_blank", "noopener");
}

async function salvarPropostaColada(chave, texto) {
  texto = texto.trim();
  if (!texto) { aviso("Cole a resposta do Claude na caixa"); return false; }
  const patch = { proposta: texto, valor_sugerido: valorDoTexto(texto) };
  try {
    await gravarRegistro(chave, patch, `proposta de ${chave} (Claude no celular)`);
    aplicarPropostasDoApp();
    desenhar();
    abrirDetalhe(chave);
    aviso("Proposta salva");
    return true;
  } catch (e) {
    aviso(`Não salvou: ${e.message}`, 4500);
    return false;
  }
}

// ---------- GitHub ----------
function b64ParaTexto(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function textoParaB64(txt) {
  const bytes = new TextEncoder().encode(txt);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

async function gh(caminho, opcoes = {}) {
  const { owner, repo, token } = config();
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${caminho}`, {
    ...opcoes,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: opcoes.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opcoes.headers || {}),
    },
    cache: "no-store",
  });
  if (r.status === 404 && opcoes.permitir404) return null;
  if (!r.ok) {
    const msg = r.status === 401 ? "token inválido ou expirado"
      : r.status === 403 ? "token sem permissão para este repositório"
      : r.status === 404 ? "repositório ou arquivo não encontrado (confira usuário/repositório e o acesso do token)"
      : `erro ${r.status} do GitHub`;
    throw new Error(msg);
  }
  return r;
}

async function lerStatusRemoto() {
  const rs = await gh(ARQ_STATUS, { permitir404: true });
  if (!rs) return { status: {}, sha: undefined };
  const j = await rs.json();
  return { status: JSON.parse(b64ParaTexto(j.content) || "{}"), sha: j.sha };
}

async function carregarRemoto() {
  const [rp, st, rm] = await Promise.all([
    gh(ARQ_OPORT, { raw: true }), lerStatusRemoto(), gh(ARQ_META, { raw: true, permitir404: true }),
  ]);
  return { projetos: await rp.json(), status: st.status, meta: rm ? await rm.json() : {} };
}

async function carregarLocal() {
  const base = new URL("../", location.href);
  const projetos = await (await fetch(new URL(ARQ_OPORT, base), { cache: "no-store" })).json();
  let status = {};
  try { status = await (await fetch(new URL(ARQ_STATUS, base), { cache: "no-store" })).json(); } catch {}
  const loc = ler("garimpo.statusLocal", {});
  for (const k of Object.keys(loc)) status[k] = loc[k];
  for (const k of Object.keys(status)) if (status[k] === null) delete status[k];
  let meta = {};
  try { meta = await (await fetch(new URL(ARQ_META, base), { cache: "no-store" })).json(); } catch {}
  return { projetos, status, meta };
}

// Mescla `patch` no registro da chave (null apaga o registro). Relê antes de gravar para não
// sobrescrever o que a CLI ou outro aparelho gravou; tenta de novo em caso de conflito.
async function gravarRegistro(chave, patch, mensagem) {
  const agora = new Date().toISOString().slice(0, 19) + "+00:00";
  const mesclar = (atual) => (patch === null ? null : { ...(atual || {}), ...patch, atualizado: agora });
  if (modoLocal()) {
    const loc = ler("garimpo.statusLocal", {});
    loc[chave] = mesclar(estado.status[chave]);
    guardar("garimpo.statusLocal", loc);
    if (loc[chave]) estado.status[chave] = loc[chave]; else delete estado.status[chave];
    return;
  }
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const { status: atual, sha } = await lerStatusRemoto();
    const novo = mesclar(atual[chave]);
    if (novo) atual[chave] = novo; else delete atual[chave];
    const corpo = {
      message: `app: ${mensagem}`,
      content: textoParaB64(JSON.stringify(atual, null, 2) + "\n"),
      ...(sha ? { sha } : {}),
    };
    try {
      await gh(ARQ_STATUS, { method: "PUT", body: JSON.stringify(corpo) });
      estado.status = atual;
      return;
    } catch (e) {
      if (tentativa === 2 || !/409|422/.test(e.message)) throw e;
    }
  }
}

// ---------- dados ----------
const statusDe = (p) => estado.status[p.chave]?.status || p.status || "novo";

function horasDesde(iso) {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 36e5;
}
function idade(iso) {
  const h = horasDesde(iso);
  if (h == null) return "";
  if (h < 1) return "agora há pouco";
  if (h < 24) return `há ${Math.floor(h)}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "há 1 dia" : `há ${d} dias`;
}
const classeNota = (n) => (n >= 65 ? "alta" : n >= 50 ? "media" : "");

// Valor de referência: o sugerido na proposta; senão o meio da faixa do cliente;
// senão (orçamento aberto) o valor estimado pelo esforço.
function valorRef(p) {
  if (p.valor_sugerido) return p.valor_sugerido;
  const a = p.valor_min_brl, b = p.valor_max_brl;
  if (a != null && b != null) return (a + b) / 2;
  return b ?? a ?? p.valor_estimado_brl ?? null;
}
const semOrcamento = (p) => p.valor_min_brl == null && p.valor_max_brl == null;
// Prazo: o "Prazo sugerido: N dias" da proposta vale mais que a estimativa automática.
function prazoDe(p) {
  const m = (p.proposta || "").match(/Prazo sugerido:\s*(\d+)/i);
  return m ? +m[1] : p.prazo_dias ?? null;
}
const NOME_COMPLEX = { baixa: "baixa", media: "média", alta: "alta" };

// Projeto exclusivo do 99Freelas: só Premium envia até liberar. Devolve Date de liberação ou null.
function liberaEm(p) {
  if (!p.exclusivo) return null;
  const ate = p.exclusivo_ate ? new Date(p.exclusivo_ate)
    : p.publicado_em ? new Date(new Date(p.publicado_em).getTime() + 864e5) : null;
  return ate && ate > new Date() ? ate : null;
}
const horaBR = (d) => d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const perfilAprovado = (plat) => estado.meta?.plataformas?.[plat]?.perfil_aprovado !== false;
const podeEnviarAgora = (p) => perfilAprovado(p.plataforma) && !liberaEm(p);

function passaFiltros(p) {
  const f = estado.filtros;
  if (f.plataforma && p.plataforma !== f.plataforma) return false;
  if (f.envio === "agora" && !podeEnviarAgora(p)) return false;
  if (f.complexidade && p.complexidade !== f.complexidade) return false;
  if (f.valor) {
    const v = valorRef(p);
    const ok = {
      ate500: v != null && v <= 500, "500a2000": v != null && v > 500 && v <= 2000,
      "2000a5000": v != null && v > 2000 && v <= 5000, "5000mais": v != null && v > 5000, sem: semOrcamento(p),
    }[f.valor];
    if (!ok) return false;
  }
  if (f.prazo) {
    const d = prazoDe(p), lim = +f.prazo;
    if (d == null || (lim === 16 ? d <= 15 : d > lim)) return false;
  }
  return true;
}

function filtrados() {
  const q = estado.busca.trim().toLowerCase();
  return estado.projetos
    .filter((p) => estado.aba === "todos" || statusDe(p) === estado.aba)
    .filter(passaFiltros)
    .filter((p) => !q || `${p.titulo} ${p.categoria} ${(p.habilidades || []).join(" ")}`.toLowerCase().includes(q))
    .sort((a, b) => (b.nota ?? 0) - (a.nota ?? 0) || new Date(b.publicado_em || 0) - new Date(a.publicado_em || 0));
}

// Lançamentos financeiros: projetos com "fin" + lançamentos avulsos (chave "manual:…").
function lancamentos() {
  const porChave = Object.fromEntries(estado.projetos.map((p) => [p.chave, p]));
  return Object.entries(estado.status)
    .filter(([, r]) => r && r.fin && r.fin.valor > 0)
    .map(([chave, r]) => {
      const p = porChave[chave];
      const taxa = r.fin.taxa_pct || 0;
      return {
        chave, manual: chave.startsWith("manual:"),
        titulo: r.titulo || p?.titulo || chave,
        plataforma: r.plataforma || p?.plataforma || "",
        bruto: r.fin.valor, taxa, liquido: r.fin.valor * (1 - taxa / 100),
        previsto: r.fin.previsto_em || "", recebido: r.fin.recebido_em || "",
        status: r.status,
      };
    });
}

// ---------- limites das plataformas ----------
function inicioDaSemana() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // segunda-feira
  return d;
}
function conexoesUsadas(plataforma) {
  const ini = inicioDaSemana();
  return Object.entries(estado.status).filter(([k, r]) =>
    k.startsWith(plataforma + ":") && r?.enviado_em && new Date(r.enviado_em) >= ini).length;
}
// Texto de aviso sobre a conta na plataforma (perfil em análise / limite semanal), ou "".
function avisoPlataforma(plataforma) {
  const conf = estado.meta?.plataformas?.[plataforma];
  if (!conf) return "";
  if (conf.perfil_aprovado === false)
    return { nivel: "alerta", texto: `${plataforma}: perfil ainda em análise (15–30 dias). Só dá para enviar propostas depois da aprovação.` };
  if (conf.conexoes_estoque != null) {
    // estoque informado numa data + propostas enviadas depois dela
    const base = new Date(`${conf.conexoes_estoque_em || "2000-01-01"}T00:00:00`);
    const enviadas = Object.entries(estado.status).filter(([k, r]) =>
      k.startsWith(plataforma + ":") && r?.enviado_em && new Date(r.enviado_em) >= base).length;
    const custo = conf.custo_por_proposta || 0;
    if (custo) {
      const saldo = conf.conexoes_estoque - enviadas * custo;
      return {
        nivel: saldo < custo * 2 ? "alerta" : "info",
        texto: `${plataforma}: ~${saldo} conexões restantes (≈ ${Math.floor(saldo / custo)} propostas). Escolha bem.`,
      };
    }
    return {
      nivel: "info",
      texto: `${plataforma}: ${conf.conexoes_estoque} conexões em ${dataBR(conf.conexoes_estoque_em)}; ` +
        `${enviadas} proposta(s) enviada(s) desde então. Confira o custo por proposta no Histórico de conexões.`,
    };
  }
  if (conf.conexoes_por_semana) {
    const usadas = conexoesUsadas(plataforma), max = conf.conexoes_por_semana;
    return {
      nivel: usadas >= max ? "alerta" : "info",
      texto: `${plataforma}: ${usadas} de ${max} propostas usadas nesta semana` +
        (usadas >= max ? " — limite atingido, renova na segunda." : ". Escolha só as melhores."),
    };
  }
  return "";
}
const htmlAviso = (a) => (a ? `<div class="faixa-aviso ${a.nivel}">${esc(a.texto)}</div>` : "");

// ---------- interface: comum ----------
function aviso(msg, ms = 2600) {
  const el = $("#aviso");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => (el.hidden = true), ms);
}

function desenhar() {
  const fin = estado.tela === "financas";
  $("#btn-financas").setAttribute("aria-pressed", fin);
  $("#titulo-tela").textContent = fin ? "Finanças" : "Garimpo Freelas";
  $("#abas").hidden = fin;
  $("#barra-filtros").hidden = fin;
  desenharResumo();
  if (fin) { desenharFinancas(); return; }
  desenharAbas();
  desenharLista();
}

function desenharResumo() {
  const coleta = estado.projetos.map((p) => p.coletado_em).filter(Boolean).sort().pop();
  const fonte = modoLocal() ? " · modo local" : "";
  $("#resumo").textContent = coleta ? `Última coleta ${idade(coleta)}${fonte}` : fonte.slice(3);
}

// ---------- interface: oportunidades ----------
function desenharFiltros() {
  document.querySelectorAll("[data-filtro]").forEach((s) => {
    s.value = estado.filtros[s.dataset.filtro] || "";
    s.classList.toggle("ativo", !!s.value);
  });
  $("#limpar-filtros").hidden = !Object.values(estado.filtros).some(Boolean);
}

function desenharAbas() {
  desenharFiltros();
  const cont = Object.fromEntries(STATUS.map(([k]) => [k, 0]));
  estado.projetos.filter(passaFiltros).forEach((p) => (cont[statusDe(p)] = (cont[statusDe(p)] || 0) + 1));
  const abas = [...STATUS, ["todos", "Todos"]];
  $("#abas").innerHTML = abas.map(([k, nome]) => {
    const n = k === "todos" ? Object.values(cont).reduce((a, b) => a + b, 0) : cont[k];
    return `<button class="aba" role="tab" data-aba="${k}" aria-selected="${estado.aba === k}">${nome}<span class="n">${n}</span></button>`;
  }).join("");
}

function desenharLista() {
  const itens = filtrados();
  const lista = $("#lista");
  if (!estado.projetos.length && !estado.carregando) {
    lista.innerHTML = `<div class="vazio">Nada carregado ainda.<br>
      ${config().token || modoLocal() ? "" : '<button class="primario" data-acao="config">Conectar ao GitHub</button>'}</div>`;
    return;
  }
  if (!itens.length) {
    const temFiltro = Object.values(estado.filtros).some(Boolean);
    lista.innerHTML = `<div class="vazio">Nenhum projeto aqui${temFiltro ? " com esses filtros" : ""}.</div>`;
    return;
  }
  // faixa de aviso das plataformas presentes na lista (só onde ainda se envia proposta)
  const avisos = estado.aba === "novo" || estado.aba === "todos"
    ? [...new Set(itens.map((p) => p.plataforma))].map(avisoPlataforma).filter(Boolean) : [];
  lista.innerHTML = avisos.map(htmlAviso).join("") + itens.map((p) => `
    <button class="cartao" data-chave="${esc(p.chave)}">
      <span class="nota ${classeNota(p.nota)}">${p.nota ?? "–"}</span>
      <span>
        <h3>${esc(p.titulo)}</h3>
        <span class="valor">${esc(valorTexto(p))}${p.valor_sugerido ? ` <span class="sugerido">· sugerido ${reais(p.valor_sugerido)}</span>` : ""}</span>
        <span class="resumo-desc">${esc((p.descricao || "").slice(0, 320))}</span>
        <span class="meta">
          <span class="selo">${esc(p.plataforma)}</span>
          ${p.proposta ? '<span class="selo">proposta pronta</span>' : ""}
          ${p.complexidade ? `<span class="selo cx-${p.complexidade}">${NOME_COMPLEX[p.complexidade]}</span>` : ""}
          ${liberaEm(p) ? `<span class="selo exclusivo">exclusivo · libera ${horaBR(liberaEm(p))}</span>` : ""}
          ${prazoDe(p) ? `<span>~${prazoDe(p)} dias</span>` : ""}
          ${estado.aba === "todos" ? `<span class="selo status">${esc(NOME_STATUS[statusDe(p)])}</span>` : ""}
          <span>${esc(p.categoria)}</span>
          ${p.propostas != null ? `<span>${p.propostas} propostas</span>` : ""}
          <span>${idade(p.publicado_em)}</span>
        </span>
      </span>
    </button>`).join("");
}

function htmlFinanceiro(chave, plataforma, sugerido) {
  const r = estado.status[chave] || {};
  const f = r.fin || {};
  const taxaPadrao = taxas()[plataforma] ?? "";
  return `
    <form class="financeiro" data-form-fin="${esc(chave)}">
      <label>Valor acordado (R$)<input name="valor" inputmode="decimal" value="${f.valor ?? sugerido ?? ""}" placeholder="0,00"></label>
      <label>Taxa da plataforma (%)<input name="taxa_pct" inputmode="decimal" value="${f.taxa_pct ?? taxaPadrao}" placeholder="ex.: 20"></label>
      <label>Previsão de pagamento<input name="previsto_em" type="date" value="${f.previsto_em || ""}"></label>
      <label>Recebido em<input name="recebido_em" type="date" value="${f.recebido_em || ""}"></label>
      <p class="ajuda" data-liquido></p>
      <div class="linha-botoes">
        <button type="button" class="secundario" data-acao="recebido-hoje">Recebi hoje</button>
        <button type="submit" class="primario">Salvar valores</button>
      </div>
    </form>`;
}

function atualizarLiquido(form) {
  const v = numero(form.valor.value), t = numero(form.taxa_pct.value) || 0;
  form.querySelector("[data-liquido]").textContent = v ? `Líquido estimado: ${reais(v * (1 - t / 100))}` : "";
}

function abrirDetalhe(chave) {
  const p = estado.projetos.find((x) => x.chave === chave);
  if (!p) return;
  const atual = statusDe(p);
  const { cabecalho, corpo } = partesProposta(p.proposta);
  const dlg = $("#detalhe");
  dlg.innerHTML = `
    <div class="folha-topo">
      <h2>${esc(p.titulo)}</h2>
      <button class="fechar" data-acao="fechar" aria-label="Fechar">×</button>
    </div>
    <div class="folha-corpo">
      <div class="valor grande">${esc(valorTexto(p))}</div>
      ${p.valor_sugerido ? `<div class="sugerido">Valor sugerido na proposta: <strong>${reais(p.valor_sugerido)}</strong></div>` : ""}
      ${htmlEstimativa(p)}
      <div class="meta" style="margin-top:6px">
        <span class="nota ${classeNota(p.nota)} pilula">nota ${p.nota ?? "–"}</span>
        ${p.complexidade ? `<span class="selo cx-${p.complexidade}">complexidade ${NOME_COMPLEX[p.complexidade]}</span>` : ""}
        ${prazoDe(p) ? `<span>entrega em ~${prazoDe(p)} dias${p.horas_estimadas && !/Prazo sugerido/i.test(p.proposta || "") ? ` (~${p.horas_estimadas}h, estimativa automática)` : ""}</span>` : ""}
        <span>${esc(p.categoria)}</span>${p.nivel ? `<span>${esc(p.nivel)}</span>` : ""}
        ${p.propostas != null ? `<span>${p.propostas} propostas</span>` : ""}
        <span>publicado ${idade(p.publicado_em)}</span>
      </div>
      ${atual === "novo" ? `<div class="secao">${htmlAviso(avisoPlataforma(p.plataforma))}</div>` : ""}
      ${atual === "novo" && liberaEm(p) ? `<div class="secao">${htmlAviso({ nivel: "alerta",
        texto: `Projeto exclusivo: só assinantes Premium enviam proposta até ${horaBR(liberaEm(p))}. Depois disso libera para você — deixe a proposta pronta e envie nesse horário.` })}</div>` : ""}
      <div class="secao linha-botoes">
        <a class="primario" href="${esc(p.url)}" target="_blank" rel="noopener">Abrir na ${esc(p.plataforma)} ↗</a>
      </div>
      ${corpo ? `
      <div class="secao">
        <h4>Proposta pronta</h4>
        ${cabecalho ? `<div class="texto cabecalho-proposta">${esc(cabecalho)}</div>` : ""}
        <div class="proposta" id="txt-proposta">${esc(corpo)}</div>
        <div class="linha-botoes" style="margin-top:8px">
          <button class="primario" data-acao="copiar">Copiar proposta</button>
        </div>
      </div>` : ""}
      ${atual === "novo" || !corpo ? `
      <div class="secao">
        <h4>${corpo ? "Refazer proposta" : "Proposta"}</h4>
        <div class="linha-botoes">
          <button class="${corpo ? "secundario" : "primario"}" data-acao="gerar">${corpo ? "Gerar outra no Claude" : "Gerar proposta no Claude"}</button>
          <button class="secundario" data-acao="colar">Colar resposta</button>
        </div>
        <div class="ajuda" style="margin-top:6px">1. Gerar: copia o pedido e abre o Claude. 2. Cole lá e envie. 3. Copie a resposta inteira e toque em Colar resposta.</div>
        <div id="pedido-manual" class="caixa-colar" hidden>
          <textarea readonly rows="6"></textarea>
        </div>
        <div id="caixa-colar" class="caixa-colar" hidden>
          <textarea rows="8" placeholder="Cole aqui a resposta do Claude (começa em Recomendação: ...)"></textarea>
          <div class="linha-botoes" style="margin-top:8px">
            <button class="primario" data-acao="salvar-colada">Salvar proposta</button>
          </div>
        </div>
      </div>` : ""}
      <div class="secao">
        <h4>Status</h4>
        <div class="status-grade">
          ${STATUS.map(([k, nome]) => `<button data-status="${k}" aria-pressed="${k === atual}">${nome}</button>`).join("")}
        </div>
      </div>
      <div class="secao" data-secao-fin ${COM_FINANCEIRO.has(atual) || estado.status[chave]?.fin ? "" : "hidden"}>
        <h4>Financeiro</h4>
        ${htmlFinanceiro(chave, p.plataforma, p.valor_sugerido)}
      </div>
      <div class="secao">
        <h4>Por que essa nota</h4>
        <ul class="motivos">${(p.motivos || []).map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
      </div>
      <div class="secao">
        <h4>Descrição</h4>
        <div class="texto descricao">${esc(p.descricao)}</div>
      </div>
      ${p.habilidades?.length ? `<div class="secao"><h4>Habilidades pedidas</h4><div class="meta">${p.habilidades.map((h) => `<span class="selo status">${esc(h)}</span>`).join("")}</div></div>` : ""}
    </div>`;
  dlg.dataset.chave = chave;
  const form = dlg.querySelector("[data-form-fin]");
  if (form) atualizarLiquido(form);
  dlg.showModal();
}

async function mudarStatus(chave, novo) {
  const anterior = estado.status[chave];
  // guarda quando a proposta foi enviada (conta no limite semanal da plataforma)
  const patch = { status: novo };
  if (novo === "proposta_enviada" && !anterior?.enviado_em) patch.enviado_em = new Date().toISOString();
  estado.status[chave] = { ...(anterior || {}), ...patch };
  desenhar();
  const dlg = $("#detalhe");
  dlg.querySelectorAll("[data-status]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.status === novo));
  const sec = dlg.querySelector("[data-secao-fin]");
  if (sec && COM_FINANCEIRO.has(novo)) sec.hidden = false;
  try {
    await gravarRegistro(chave, patch, `${chave} -> ${novo}`);
    desenhar();
    aviso(`Marcado: ${NOME_STATUS[novo]}`);
  } catch (e) {
    if (anterior) estado.status[chave] = anterior; else delete estado.status[chave];
    desenhar();
    aviso(`Não salvou: ${e.message}`, 4500);
  }
}

async function salvarFinanceiro(form, extra = {}) {
  const chave = form.dataset.formFin;
  const valor = numero(form.valor.value);
  if (!valor) { aviso("Informe o valor acordado"); return false; }
  const fin = {
    valor, taxa_pct: numero(form.taxa_pct.value) || 0,
    previsto_em: form.previsto_em.value || null, recebido_em: form.recebido_em.value || null,
  };
  try {
    await gravarRegistro(chave, { fin, ...extra }, `financeiro ${chave}`);
    aviso(fin.recebido_em ? "Valores salvos · recebido" : "Valores salvos · a receber");
    desenhar();
    return true;
  } catch (e) {
    aviso(`Não salvou: ${e.message}`, 4500);
    return false;
  }
}

// ---------- interface: finanças ----------
function desenharFinancas() {
  const itens = lancamentos();
  const mes = hoje().slice(0, 7);
  const recebidos = itens.filter((i) => i.recebido).sort((a, b) => b.recebido.localeCompare(a.recebido));
  const aReceber = itens.filter((i) => !i.recebido).sort((a, b) => (a.previsto || "9").localeCompare(b.previsto || "9"));
  const soma = (l, k = "liquido") => l.reduce((s, i) => s + i[k], 0);
  const noMes = recebidos.filter((i) => i.recebido.startsWith(mes));
  const linha = (i) => {
    const atrasado = !i.recebido && i.previsto && i.previsto < hoje();
    return `
    <button class="cartao lanc" data-lanc="${esc(i.chave)}">
      <span>
        <h3>${esc(i.titulo)}</h3>
        <span class="meta">
          ${i.plataforma ? `<span class="selo">${esc(i.plataforma)}</span>` : ""}
          ${i.manual ? '<span class="selo status">avulso</span>' : ""}
          <span>bruto ${reais(i.bruto)}${i.taxa ? ` · taxa ${i.taxa}%` : ""}</span>
          <span class="${atrasado ? "atrasado" : ""}">${i.recebido ? `recebido ${dataBR(i.recebido)}` : i.previsto ? `previsto ${dataBR(i.previsto)}${atrasado ? " (atrasado)" : ""}` : "sem previsão"}</span>
        </span>
      </span>
      <span class="lanc-valor ${i.recebido ? "ok" : ""}">${reais(i.liquido)}</span>
    </button>`;
  };
  $("#lista").innerHTML = `
    <section class="totais">
      <div class="total"><span>A receber</span><strong>${reais(soma(aReceber))}</strong><small>${aReceber.length} lançamento(s)</small></div>
      <div class="total"><span>Recebido no mês</span><strong>${reais(soma(noMes))}</strong><small>${noMes.length} lançamento(s)</small></div>
      <div class="total largo"><span>Recebido no total</span><strong>${reais(soma(recebidos))}</strong><small>valores líquidos, já sem a taxa da plataforma</small></div>
    </section>
    <button class="secundario largo-botao" data-acao="novo-lancamento">+ Lançamento avulso</button>
    <h4 class="titulo-grupo">A receber</h4>
    ${aReceber.map(linha).join("") || '<p class="vazio pequeno">Nada a receber. Ao aceitar um projeto, preencha o valor em "Financeiro".</p>'}
    <h4 class="titulo-grupo">Recebidos</h4>
    ${recebidos.map(linha).join("") || '<p class="vazio pequeno">Nenhum recebimento ainda.</p>'}`;
}

function abrirLancamento(chave) {
  const novo = !chave;
  chave = chave || `manual:${Date.now()}`;
  const r = estado.status[chave] || {};
  const dlg = $("#detalhe");
  dlg.innerHTML = `
    <div class="folha-topo">
      <h2>${novo ? "Novo lançamento avulso" : esc(r.titulo || "Lançamento")}</h2>
      <button class="fechar" data-acao="fechar" aria-label="Fechar">×</button>
    </div>
    <div class="folha-corpo config">
      <p class="ajuda">Para trabalhos fora do garimpo (indicação, cliente direto, outra plataforma).</p>
      <label>Descrição<input id="lanc-titulo" value="${esc(r.titulo || "")}" placeholder="ex.: Planilha de estoque — cliente X"></label>
      <label>Origem<select id="lanc-plataforma">
        ${["99freelas", "workana", "direto", "outra"].map((o) => `<option ${o === (r.plataforma || "direto") ? "selected" : ""}>${o}</option>`).join("")}
      </select></label>
      ${htmlFinanceiro(chave, r.plataforma || "direto")}
      ${novo ? "" : '<button type="button" class="perigo" data-acao="apagar-lancamento">Apagar lançamento</button>'}
    </div>`;
  dlg.dataset.chave = chave;
  dlg.dataset.manual = "1";
  atualizarLiquido(dlg.querySelector("[data-form-fin]"));
  dlg.showModal();
}

// ---------- carregamento ----------
async function carregar() {
  if (estado.carregando) return;
  if (!config().token && !modoLocal()) { desenhar(); preencherConfig(); $("#config").showModal(); return; }
  estado.carregando = true;
  $("#btn-atualizar").classList.add("girando");
  try {
    const { projetos, status, meta } = modoLocal() ? await carregarLocal() : await carregarRemoto();
    Object.assign(estado, { projetos, status, meta });
    guardar("garimpo.cache", { projetos, status, meta });
    aplicarPropostasDoApp();
  } catch (e) {
    aviso(`Não carregou: ${e.message}`, 4500);
  } finally {
    estado.carregando = false;
    $("#btn-atualizar").classList.remove("girando");
    if (!$("#detalhe").open) desenhar();
  }
}

function preencherConfig() {
  const c = config(), t = taxas(), f = $("#form-config");
  f.owner.value = c.owner; f.repo.value = c.repo; f.token.value = c.token;
  f.taxa99.value = t["99freelas"]; f.taxaWk.value = t.workana;
}

// ---------- eventos ----------
$("#abas").addEventListener("click", (e) => {
  const b = e.target.closest("[data-aba]");
  if (!b) return;
  estado.aba = b.dataset.aba;
  guardar("garimpo.aba", estado.aba);
  desenhar();
  window.scrollTo({ top: 0 });
});
$("#busca").addEventListener("input", (e) => { estado.busca = e.target.value; desenharLista(); });
$("#filtros").addEventListener("change", (e) => {
  const s = e.target.closest("[data-filtro]");
  if (!s) return;
  estado.filtros[s.dataset.filtro] = s.value;
  guardar("garimpo.filtros", estado.filtros);
  desenhar();
});
$("#limpar-filtros").addEventListener("click", () => {
  estado.filtros = {};
  guardar("garimpo.filtros", estado.filtros);
  desenhar();
});
$("#lista").addEventListener("click", (e) => {
  if (e.target.closest("[data-acao=config]")) { preencherConfig(); $("#config").showModal(); return; }
  if (e.target.closest("[data-acao=novo-lancamento]")) { abrirLancamento(null); return; }
  const l = e.target.closest("[data-lanc]");
  if (l) {
    const k = l.dataset.lanc;
    if (k.startsWith("manual:")) abrirLancamento(k);
    else if (estado.projetos.some((p) => p.chave === k)) abrirDetalhe(k);
    else aviso("Projeto antigo fora da lista atual");
    return;
  }
  const c = e.target.closest("[data-chave]");
  if (c) abrirDetalhe(c.dataset.chave);
});

const dlgDetalhe = $("#detalhe");
dlgDetalhe.addEventListener("close", () => { delete dlgDetalhe.dataset.manual; desenhar(); });
dlgDetalhe.addEventListener("input", (e) => { const f = e.target.closest("[data-form-fin]"); if (f) atualizarLiquido(f); });
dlgDetalhe.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-form-fin]");
  if (!form) return;
  e.preventDefault();
  let extra = {};
  if (dlgDetalhe.dataset.manual) {
    const titulo = $("#lanc-titulo").value.trim();
    if (!titulo) { aviso("Dê uma descrição ao lançamento"); return; }
    extra = { titulo, plataforma: $("#lanc-plataforma").value };
  }
  if (await salvarFinanceiro(form, extra) && dlgDetalhe.dataset.manual) dlgDetalhe.close();
});
dlgDetalhe.addEventListener("click", async (e) => {
  if (e.target === dlgDetalhe || e.target.closest("[data-acao=fechar]")) { dlgDetalhe.close(); return; }
  const s = e.target.closest("[data-status]");
  if (s) { mudarStatus(dlgDetalhe.dataset.chave, s.dataset.status); return; }
  if (e.target.closest("[data-acao=recebido-hoje]")) {
    const form = dlgDetalhe.querySelector("[data-form-fin]");
    form.recebido_em.value = hoje();
    form.requestSubmit();
    return;
  }
  if (e.target.closest("[data-acao=apagar-lancamento]")) {
    if (!confirm("Apagar este lançamento?")) return;
    try { await gravarRegistro(dlgDetalhe.dataset.chave, null, "apaga lançamento avulso"); dlgDetalhe.close(); aviso("Lançamento apagado"); }
    catch (err) { aviso(`Não apagou: ${err.message}`, 4500); }
    return;
  }
  if (e.target.closest("[data-acao=gerar]")) {
    const p = estado.projetos.find((x) => x.chave === dlgDetalhe.dataset.chave);
    if (p) gerarProposta(p);
    return;
  }
  if (e.target.closest("[data-acao=colar]")) {
    const caixa = $("#caixa-colar");
    caixa.hidden = false;
    const area = caixa.querySelector("textarea");
    try { const t = await navigator.clipboard.readText(); if (t && /Proposta/i.test(t)) area.value = t; } catch {}
    area.focus();
    caixa.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (e.target.closest("[data-acao=salvar-colada]")) {
    salvarPropostaColada(dlgDetalhe.dataset.chave, $("#caixa-colar textarea").value);
    return;
  }
  if (e.target.closest("[data-acao=copiar]")) {
    try { await navigator.clipboard.writeText($("#txt-proposta").textContent); aviso("Proposta copiada"); }
    catch { aviso("Não deu para copiar — selecione o texto e copie"); }
  }
});

$("#btn-atualizar").addEventListener("click", carregar);
$("#btn-financas").addEventListener("click", () => {
  estado.tela = estado.tela === "financas" ? "oportunidades" : "financas";
  guardar("garimpo.tela", estado.tela);
  desenhar();
  window.scrollTo({ top: 0 });
});
$("#btn-config").addEventListener("click", () => { preencherConfig(); $("#config").showModal(); });
$("#config").addEventListener("close", () => {
  if ($("#config").returnValue !== "salvar") return;
  const f = $("#form-config");
  guardar("garimpo.config", { owner: f.owner.value.trim(), repo: f.repo.value.trim(), token: f.token.value.trim() });
  guardar("garimpo.taxas", { "99freelas": numero(f.taxa99.value) ?? "", workana: numero(f.taxaWk.value) ?? "" });
  carregar();
});
$("#btn-sair").addEventListener("click", () => {
  guardar("garimpo.config", { ...config(), token: "" });
  try { localStorage.removeItem("garimpo.cache"); } catch {}
  Object.assign(estado, { projetos: [], status: {} });
  $("#config").close();
  desenhar();
  aviso("Token apagado deste aparelho");
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && estado.projetos.length && !$("#detalhe").open) carregar();
});

// ---------- início ----------
estado.aba = ler("garimpo.aba", "novo");
estado.tela = ler("garimpo.tela", "oportunidades");
estado.filtros = ler("garimpo.filtros", {});
const cache = ler("garimpo.cache", null);
if (cache) { Object.assign(estado, cache); aplicarPropostasDoApp(); }
desenhar();
carregar();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
