# DIAGNÓSTICO BLOQUEANTE — S07-1 · HTTP 503 no Painel KDS

**Data:** 2026-11-17 / 2026-11-18  
**Escopo:** somente diagnóstico — **nenhuma alteração de código**.  
**Banco oficial:** não aberto por testes; evidência do runtime vem do log do `npm start` já em execução.

---

## 1. Causa exata do HTTP 503

O módulo Cozinha **não está operacional** no processo Node iniciado (`npm start`).

Na inicialização do banco (`database.js` → `garantirSchemaCozinha`), o schema Cozinha falhou em:

`PRAGMA foreign_key_check` → **2082 violações de FK**.

Isso marca `isCozinhaOperacional() === false` via `marcarCozinhaOperacional(false, err)`.

Cada `GET /api/cozinha/preparacao/painel` passa pelo gate:

`backend/rotas/cozinha.js` → `exigirCozinhaOperacional(res)` (**linhas 78–89**, chamado na **linha 183**).

Como o módulo não está operacional, a rota responde **503** imediatamente e **não executa** `CozinhaKdsPainelService.listarPainelPreparacao()`.

**Código HTTP / negócio:**

| Campo | Valor |
|-------|--------|
| Status | `503` |
| `codigo` | `COZINHA_NAO_OPERACIONAL` |
| `mensagem` | `Módulo Cozinha não operacional.` |
| Causa raiz persistida | `[COZINHA] foreign_key_check encontrou 2082 violação(ões).` (`COZINHA_FK_CHECK_FALHOU` / armazenado como falha de schema) |

**Não é:** falha de autenticação (401), empresa (403), unidade (403/409), conexão SQL na hora do GET, nem bug do frontend em montar a URL.

---

## 2. Log do backend correspondente

Do terminal ativo `npm start` (porta do app em uso), repetido a cada poll do KDS (~5s):

```
[COZINHA] não operacional: [COZINHA] foreign_key_check encontrou 2082 violação(ões).
```

Trechos observados (UTF-8 com encoding do console):

```
[COZINHA] n├úo operacional: [COZINHA] foreign_key_check encontrou 2082 viola├º├úo(├Áes).
```

Frequência alinhada ao polling S07-1 (várias ocorrências em intervalo de ~5s).

Origem do log: `exigirCozinhaOperacional` em `backend/rotas/cozinha.js` linhas 81–82:

```javascript
if (st.erro) {
  console.error('[COZINHA] não operacional:', st.erro.mensagem || st.erro);
}
```

Na boot, o catch em `database.js` (~3119–3127) também registra `FALHA_SCHEMA` e força `marcarCozinhaOperacional(false, err)` sem derrubar o ERP/PDV.

---

## 3. Corpo integral da resposta HTTP 503

```json
{
  "success": false,
  "codigo": "COZINHA_NAO_OPERACIONAL",
  "mensagem": "Módulo Cozinha não operacional."
}
```

(Produzido por `exigirCozinhaOperacional` — **não** inclui `detalhes` das 2082 FKs no JSON da rota; o detalhe fica só no status/erro interno e no log.)

---

## 4. Arquivo e linha responsáveis

| Camada | Arquivo | Linhas | Papel |
|--------|---------|--------|-------|
| Gate HTTP 503 | `backend/rotas/cozinha.js` | **78–89**, chamada em **183** | Emite 503 `COZINHA_NAO_OPERACIONAL` |
| Serviço NÃO executado | `CozinhaKdsPainelService.listarPainelPreparacao` | — | Não chega a rodar |
| Flag operacional | `backend/utils/cozinhaSchema.js` | `marcarCozinhaOperacional` / `isCozinhaOperacional` | Estado em memória |
| FK check | `backend/utils/cozinhaSchema.js` | **205–214** (`pragmaForeignKeyCheckOk`) | Lança erro com 2082 violações |
| Chamada do check | `backend/utils/cozinhaSchema.js` | **~474–475** (fluxo de migração/recriação) | Dispara a falha na boot |
| Tolerância ERP | `backend/database.js` | **3107–3127** | Captura falha; Cozinha fica off; ERP sobe |
| Registro da rota | `backend/server.js` | **245** | `app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes)` — rota **está registrada** |
| Frontend (sintoma) | `frontend/erp/js/cozinha-kds.js` | **~375–388** (`requisitar`) | Lê 503 e propaga erro; **não causa** o 503 |

---

## 5. Evidência de reprodução isolada

Script: `Agent/_diag-s07-1-503-isolado.js`  
Resultado: `Agent/DIAGNOSTICO-S07-1-HTTP-503.json`

- `CDS_BLOQUEAR_BANCO_OFICIAL=1`
- Sem abrir banco oficial
- Simula o mesmo estado (`marcarCozinhaOperacional(false, erroFk)`)
- `GET /api/cozinha/preparacao/painel` → **503** + corpo acima
- Confirma: serviço **não** é chamado após o gate

---

## 6. Verificações da Etapa 1 (backend)

| # | Pergunta | Resultado |
|---|----------|-----------|
| 1 | Log completo no momento | `[COZINHA] não operacional: … foreign_key_check … 2082` |
| 2 | Corpo JSON 503 | `COZINHA_NAO_OPERACIONAL` (acima) |
| 3 | Rota registrada na 3001/app | Sim — `server.js` monta `/api/cozinha` + `GET /preparacao/painel` |
| 4 | Middleware/gate 503 | Sim — `exigirCozinhaOperacional` |
| 5 | Interceptação antes do serviço | Sim — return na linha 183 antes de `listarPainelPreparacao` |
| 6 | Serviço executado? | **Não** |
| 7 | Falha de conexão no GET? | **Não** (falha de schema na boot; flag em memória) |
| 8 | Empresa/unidade | Gate dispara **antes** de validar unidade/serviço; auth/recurso já passaram (senão seria 401/403 de token/recurso) |

---

## 7. Verificações da Etapa 2 (frontend)

| # | Pergunta | Resultado |
|---|----------|-----------|
| 1 | Headers `headersAuth()` | `Accept`, `Authorization: Bearer <token>`, `X-Empresa-Id` se empresa selecionada — adequados |
| 2 | Status/corpo | 503 + JSON acima; linha ~381 é o `fetch`, não a origem |
| 3 | Tratamento UI | Captura erro, exibe aviso, **preserva** últimos dados válidos (neste caso nunca houve sucesso) |
| 4 | Poll 5s / sobreposição | Continua a cada 5s; `emCurso` evita sobreposição — gera **spam de log** no backend a cada ciclo |
| 5 | Desacelerar em 503? | **Recomendável** (backoff), ainda não implementado |

---

## 8. Correção recomendada (**não implementar nesta etapa**)

Ordem sugerida para autorização futura do TL:

1. **Diagnóstico de dados (autorizado e isolado):** inspecionar amostra de `PRAGMA foreign_key_check` (quais tabelas/FKs) em cópia/temp — **não** corrigir às cegas no oficial.
2. **Remediar as 2082 violações de FK** do domínio Cozinha (ou estratégia de migração/reparo aprovada), de forma que `garantirSchemaCozinha` conclua com `marcarCozinhaOperacional(true)`.
3. **Reiniciar** o processo Node e confirmar `GET /api/cozinha/status` → `operacional: true`.
4. **Só então** validar o Painel KDS.
5. **Opcional S07-1 UX:** backoff no poll quando `codigo === COZINHA_NAO_OPERACIONAL` (ex.: 30–60s) para reduzir ruído; não resolve a causa.
6. **Não** contornar o gate `exigirCozinhaOperacional` no S07-0/S07-1 — o 503 é proteção correta.

---

## Veredito

**Causa raiz:** schema Cozinha falhou na boot por `foreign_key_check` (2082 violações) → módulo marcado não operacional → gate da rota KDS devolve 503 `COZINHA_NAO_OPERACIONAL` antes do serviço.

**PARAR. Aguardar autorização do Tech Lead para qualquer correção.**
