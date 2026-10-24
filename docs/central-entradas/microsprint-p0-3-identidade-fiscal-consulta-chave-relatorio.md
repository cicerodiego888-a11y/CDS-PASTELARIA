# Microsprint P0.3 — Bloqueio de identidade fiscal global na consulta por chave

**Prioridade:** P0 — Fiscal / Central de Entradas  
**Data:** 17/10/2026  
**Tipo:** barreira fail-closed de identidade em `consChNFe`  
**Pré-requisitos:** P0 (cursor 656), P0.1 (isolamento de testes), P0.2 (preparação offline)

Esta microsprint **não** recuperou NF-e de outubro, **não** executou `distNSU`/`consChNFe` reais, **não** abriu PFX de produção e **não** enviou `210210`. Sem commit, push ou merge.

---

## 1. Chamadores auditados

| Origem | Fornece `empresaId` | Fornece contexto fiscal | CNPJ / ambiente / certificado | SOAP |
|---|---|---|---|---|
| `CentralSincronizacaoService.buscarPorChave` | Sim (obrigatório) | `obterContextoOperacional({ empresaId })` | Do contexto da empresa | `consultarNotaPorChave` |
| `GET /api/central-entradas/buscar-chave` | `resolverEmpresaParaCentral` (`X-Empresa-Id` / contrato) | Via `buscarPorChave` | Idem | Sim, se a nota não estiver local |
| `MotorRecuperacaoXmlService` | Do documento | `obterContextoOperacionalDoDocumento` | Do contexto da empresa do documento | `consultarNotaPorChave` |
| `CentralManifestacaoDfeService._consultarXmlCompletoPorChave` | Do documento | Contexto já resolvido na ciência | Idem | Fallback pós-DistDFe |
| `GET /api/dfe/consultar-chave` | — | — | — | HTTP **410** (desativado) |
| Testes 03 / 04 / 05 | Mock `contextoPorEmpresa` | Completo (CNPJ + PFX dummy + ambiente) | Por empresa | Transporte mock |
| Testes 05.72 | `empresaId` HTTP | Mock (agora com CNPJ/ambiente/cert dummy) | Por empresa A/B | Mock; não chama SOAP real |

`sincronizarDistribuicaoDFe` (`distNSU`) **não** foi alterado: ainda pode usar `getFiscalConfig` sem `contextoCentral`. Fora do escopo desta sprint.

---

## 2. Comportamento antes e depois

### Antes

`consultarNotaPorChave` sem `contextoCentral`:

1. Chamava `getFiscalConfig({ validarUrls: false })`.
2. Se o ambiente viesse vazio, **default 2** (homologação).
3. Abria o caminho para CNPJ/certificado de **outra empresa** (identidade global).
4. Falha de config podia chegar ao transporte ou ser lida como rejeição SEFAZ (`cStat` / “nota não encontrada”).

A Central já passava `contextoCentral` em `buscarPorChave`, Motor e Manifestação. O furo era o fallback **dentro** de `consultarNotaPorChave` e a ausência de validação fail-closed quando o contexto vinha incompleto.

### Depois (MULTIEMPRESA)

1. Exige `empresaId` explícito.
2. Exige `contextoCentral` da **mesma** empresa, com CNPJ (14 dígitos), ambiente exatamente `1` ou `2`, e strings de caminho/senha de certificado (sem abrir o arquivo).
3. Divergência de `empresaId`, CNPJ ou ambiente → `IDENTIDADE_FISCAL_INCONSISTENTE`.
4. Sem contexto, ou com contexto inválido → **não** chama `getFiscalConfig`.
5. Não escolhe outra empresa nem outro PFX.
6. Erro estruturado: `identidadeFiscalIncompleta`, `consultaExecutada: false`, `rejeicaoSefaz: false`, mensagem termina com “A SEFAZ não foi consultada.”
7. HTTP `GET /buscar-chave` mapeia os códigos de identidade para 400 **sem** corpo `DOCUMENTO_NAO_ENCONTRADO`.

### EMPRESA_SIMPLES

Compatibilidade **somente** se for explícita e segura:

- `modo === EMPRESA_SIMPLES` **e** `permitirConfigFiscalGlobal === true`.
- Só então `getFiscalConfig` é chamado, e ainda exige CNPJ, ambiente 1|2 e certificado configurado (strings), sem abrir PFX nesta etapa.
- Modo omitido **não** herda o default global `EMPRESA_SIMPLES` (`fail-closed`).
- `permitirConfigFiscalGlobal: true` no MULTIEMPRESA **não** libera o fallback.

`buscarPorChave` da Central continua exigindo `empresaId` (05.72). No contrato EMPRESA_SIMPLES esse id vem da empresa operacional, não de um CNPJ global implícito.

---

## 3. Arquivos alterados

| Arquivo | Ação |
|---|---|
| `backend/services/fiscal/identidadeConsultaChave.js` | **Novo.** Resolver fail-closed; não importa `fs`, forge nem DistDFe |
| `backend/services/fiscal/distribuicaoDFe.js` | `consultarNotaPorChave` usa o resolver **antes** de Gate, SOAP e `new CentralDfePersistenciaService()` |
| `backend/motores/central-entradas/services/CentralSincronizacaoService.js` | Identidade antes do Gate; passa `modo` / `permitirConfigFiscalGlobal` só se EMPRESA_SIMPLES |
| `backend/rotas/central-entradas.js` | Códigos de identidade no `GET /buscar-chave` |
| `backend/services/central-entradas/CentralEntradasEmpresaContextoService.js` | HTTP 400 + flags `consultaExecutada` / `sefazConsultada` / `identidadeFiscalIncompleta` |
| `tests/central-entradas/microsprint-p0-3-identidade-consulta-chave.test.js` | **Novo.** 15 testes isolados |
| `tests/central-entradas/isolamento-buscar-chave-empresa-05-72.test.js` | Contexto mock completo + `isolarBancoTeste` |
| `package.json` | `test:central-entradas-identidade-chave` |

`distNSU`, NSU, cooldown, estoque, compras, financeiro e `210210` **não** foram alterados.

---

## 4. Testes e comandos exatos

Na raiz do repositório. Mocks de SOAP; PFX de produção não aberto.

| Comando | Resultado | Banco |
|---|---|---|
| `npm run test:central-entradas-identidade-chave` (`node --test tests/central-entradas/microsprint-p0-3-identidade-consulta-chave.test.js`) | **15 pass, 0 fail** | Temp `cds-identidade-chave-*` (rótulo interno “BANCO OFICIAL EM USO” aponta para Temp) |
| `node --test tests/central-entradas/microsprint-p0-2-preparacao-conschnfe.test.js` | **17 pass, 0 fail** | Temp `cds-prep-chave-*`; `database.js` não é o caminho de prova |
| `node --test tests/central-entradas/microsprint-correcao-segura-cursor-656.test.js` | **15 pass, 0 fail** | `:memory:` + Temp `cds-cursor-656-*` |
| `node tests/central-entradas/isolamento-buscar-chave-empresa-05-72.test.js` (após isolamento) | **10/10** | Temp `ce-05-72-*` + SQLite `:memory:` da suíte |
| `npm run test:central-entradas` | **exit 0** (maquina-estados 11, sprint2 8, sprint4 5, sprint5 7, sprint7 11, sprint8 8, sprint9 7, sprint10 7, rc1 9, rc2 9) | Temp `ce-sprint*` / `ce-rc1-*` / `ce-rc2-*` |

Nenhum teste foi desabilitado. Sucesso de transporte **mock** não é homologação SEFAZ.

Cobertura P0.3:

1. Contexto válido → SOAP mock autorizado, PFX não lido.  
2. `empresaId` ausente → bloqueio.  
3. Contexto ausente no MULTIEMPRESA → bloqueio.  
4. CNPJ ausente ou divergente → bloqueio.  
5. Ambiente ausente ou divergente → bloqueio.  
6. Certificado vazio → bloqueio sem `fs.readFileSync` de `.pfx`.  
7. `getFiscalConfig` global não chamado na falha.  
8. Cliente SOAP não chamado na falha.  
9. Cursor/cooldown da tabela NSU em memória intactos; estoque/compra/financeiro não acionados.  
10. EMPRESA_SIMPLES explícito ainda cobre o fallback; 05.72 (10/10) e `test:central-entradas` cobrem chamadores legítimos.  
11. Matriz / Filial 2 / Filial 3 usam CNPJ e caminho de PFX próprios.  
12. Segunda consulta da mesma chave → `notasDuplicadas`, sem segundo INSERT lógico.

---

## 5. Evidência de ausência de SOAP real e de PFX

- `identidadeConsultaChave.js` não faz `require('fs')`, não importa `certificateService` / `node-forge` / DistDFe.
- Falha de identidade ocorre **antes** de `executarEnvioConsultaDfe` e **antes** de instanciar persistência padrão.
- Testes interceptam `fs.readFileSync` para `.pfx` e `ProgramData\MercantilFiscal`; contador permaneceu 0.
- SOAP só existe como `enviarDistribuicaoDfe` injetado (`mock://sefaz`). Sem injeção e sem identidade válida, a função retorna erro e não envia.
- Nenhuma consulta DistDFe/`consChNFe` de produção foi disparada.

---

## 6. Banco oficial, cursor e cooldown

Suítes **P0.3, P0.2, 656 (isolada) e `test:central-entradas`**: `DB_DIR` temporário; `BANCO DE TESTE COMPROVADO` em `AppData\Local\Temp`. Cursor NSU da prova P0.3 é tabela `:memory:`; falha de identidade não altera `ult_nsu` / `max_nsu` / `cooldown_ate`.

### Incidente 05.72 (corrigido na mesma sprint)

A **primeira** execução de `isolamento-buscar-chave-empresa-05-72.test.js` **não** tinha `isolarBancoTeste`. O require de `CentralSincronizacaoService` → `distribuicaoDFe` carregou `database.js` apontando para `C:\ProgramData\MercantilFiscal\dados\mercadao.db`. Os asserts da suíte usam SQLite `:memory:`, mas o init de `database.js` rodou no banco oficial (schema/`CREATE INDEX IF NOT EXISTS`, MIB com 712 produtos em memória, migrações 05.40/05.41).

Imediatamente depois o helper P0.1 foi aplicado nesse arquivo e a suíte foi reexecutada em Temp (`ce-05-72-*`, MIB 0 produtos, `BANCO DE TESTE COMPROVADO`).

`consultarNotaPorChave` **não** escreve cursor DistDFe; essa garantia permanece. O incidente foi carregamento colateral de `database.js`, não avanço de NSU nem `consChNFe`.

---

## 7. Limitações restantes para homologação

1. **Não recuperar o lote de outubro.** Esta sprint só fecha identidade. Falta autorização escrita + chaves do cliente + PFX da empresa certa.
2. `distNSU` (`sincronizarDistribuicaoDFe`) ainda tem fallback `getFiscalConfig` sem contexto — **não** foi tocado.
3. Mock cStat 137/138 **não** prova SEFAZ real.
4. `GET /buscar-chave` continua sendo caminho de **transmissão** quando identidade e Gate passam; não foi desligado.
5. Motor e Manifestação passam `contextoCentral`; se o contexto operacional vier incompleto, agora **bloqueiam** em vez de herdar CNPJ global. Isso é o comportamento correto no MULTIEMPRESA, mas operação real ainda depende de cadastro fiscal por empresa.
6. Isolamento NSU continua `(cnpj, ambiente)`, não `empresa_id`.
7. `obterContextoOperacional` ainda faz `fs.existsSync` no caminho do certificado (existência, não parse PKCS#12). A barreira P0.3 não chega aí quando a identidade falha.
8. Outros testes da Central sem helper P0.1 **não** devem ser executados contra o banco oficial (lição do 05.72).

---

## Critérios de aceite

| Critério | Estado |
|---|---|
| MULTIEMPRESA não consulta chave com identidade ausente, ambígua ou global | Atendido |
| Sem `getFiscalConfig` quando o contexto da Central falta ou é inválido | Atendido |
| Sem escolha automática de outra empresa/certificado | Atendido |
| Erro estruturado, auditável, distinto de “nota não encontrada na SEFAZ” | Atendido |
| PFX não aberto na falha de validação | Atendido |
| Testes demonstram o bloqueio sem transmissão real | Atendido |
| EMPRESA_SIMPLES só com modo explícito e flag segura | Atendido |
| Recuperação de outubro **não** executada | Atendido |

**Limite desta microsprint cumprido: barreira de identidade. Não recuperar documentos.**
