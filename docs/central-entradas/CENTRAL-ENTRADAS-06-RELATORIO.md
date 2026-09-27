# CENTRAL-ENTRADAS-06 — Relatório

Pendências: **P01** (seleção de candidatos), **P04** (ambiente por empresa), **P09** (certificado por empresa),
**P14** (Gate 593/fingerprint por empresa) e **P15** (diagnóstico por empresa).

Regra arquitetural aplicada: empresa selecionada → contexto operacional → CNPJ → ambiente → certificado → NSU →
Gate → operação. No MULTIEMPRESA não há fallback global silencioso.

---

## 1. Objetivo

Fazer a Central operar e apresentar informações **por empresa**, sem alterar configurações fiscais reais e sem
fallback global silencioso no modo MULTIEMPRESA:

- seleção justa e por urgência dos candidatos à ciência;
- painel com ambiente e certificado da empresa selecionada;
- 593 bloqueando apenas a empresa afetada;
- diagnóstico exigindo empresa.

## 2. P01 — antes / depois

| | Antes | Depois |
|---|---|---|
| Fonte | `listarPorStatus(AGUARDANDO_XML_COMPLETO, limite)`, ordenado por `created_at ASC` | `listarPendentesManifestacao(500)`, ordenado por `data_emissao DESC` |
| Corte | `LIMIT = limite` (10) **antes** de qualquer elegibilidade | Limite aplicado **depois** da elegibilidade e da distribuição |
| Efeito | 10 documentos antigos inelegíveis ocupavam o lote para sempre (*top-N global*) | Os inelegíveis são descartados com motivo e os elegíveis entram |
| Filtro | somente `tipoDocumento === RES_NFE` | empresa, contexto, prazo, 596, aceite, claim, Gate e janela (ver seção 3) |
| Empresas | nenhuma noção de empresa | cota round-robin por empresa |
| DTO | `CandidatoManifestacaoDTO` não era usado | usado na seleção (estado, prazo, prioridade) |

**Ligação a `processarCandidatos`:**
- `processarCandidatos` chama `_selecionarCandidatosManifestacao({ limite })` e processa os selecionados, em série como antes.
- O retorno ganhou `selecao: { avaliados, elegiveis, excluidosPorMotivo, porEmpresa }`.

**O que não mudou:**
- política (sai cedo se não for `AUTOMATICA_CIENCIA`);
- `origemAutomatica: true` (CE-05);
- `apenasManifestacao`;
- limite padrão 10 e teto 50.

## 3. Estratégia de seleção

Método `CentralManifestacaoDfeService._selecionarCandidatosManifestacao`. Os documentos são avaliados em ordem, e a primeira exclusão aplicável define o motivo:

| # | Verificação | Motivo de exclusão |
|---|---|---|
| 1 | tipo `RES_NFE` | `TIPO_NAO_ELEGIVEL` |
| 2 | `empresaId` presente; sem empresa só é aceito no `EMPRESA_SIMPLES`, via `permitirFallbackGlobalPorModo` já existente | `SEM_EMPRESA` |
| 3 | contexto válido via `obterContextoOperacionalDoDocumento` já existente (MULTIEMPRESA → `permitirFallbackGlobal:false`); cache por empresa | `CONTEXTO_INVALIDO` |
| 4 | sem `MANIFESTACAO_ACEITA` | `CIENCIA_ACEITA` |
| 5 | sem rejeição 596 | `PRAZO_EXPIRADO_596` |
| 6 | sem claim vivo (`MANIFESTACAO_CLAIM` com idade < `TTL_CLAIM_MANIFESTACAO_MS` da CE-05; um claim expirado volta a ser elegível) | `CLAIM_ATIVO` |
| 7 | Gate da empresa livre: `gate.avaliarBloqueioContexto(ctx)`, uma leitura nova sem log nem métrica, com cache por contexto | `GATE_BLOQUEADO` |
| 8 | sem janela futura: `proximaConsultaEm` de rejeição anterior ou de `CONSULTA_DFE_POS_MANIFESTACAO` | `JANELA_FUTURA` |
| 9 | dentro do prazo pela regra do DTO: prioridade 0..10 = dias restantes, `SEM_CIENCIA` | `FORA_DO_PRAZO` |

**Ordenação (determinística):**
1. menor `dataLimiteManifestacao` (menor prazo restante);
2. menor `dataEmissao`;
3. `chave`;
4. `documentoId`.

Documentos sem data de emissão vão por último.

**Implementação:**
- Os helpers de evento da CE-05 foram reutilizados: `_obterUltimoEvento`, `_ehRejeicaoXmlIndisponivel`, `_obterBloqueioRejeicao`, `_obterProximaConsulta` e `_inicioClaim`.
- Não foi criado novo motor, fila, Gate ou claim.
- Nenhum documento é excluído do banco. "Excluído" significa apenas "não selecionado neste ciclo".

## 4. Cota multiempresa

A função `distribuirPorEmpresa` faz um round-robin sobre as filas por empresa, já ordenadas por urgência:
- As empresas são visitadas pela urgência do seu candidato mais urgente; no empate, vence o menor `empresaId`.
- Cada rodada pega um documento de cada empresa, até o limite.
- Uma empresa sozinha preenche o lote inteiro (P01-10).
- Uma empresa bloqueada ou sem contexto não consome cota das outras (P01-08).
- A distribuição é determinística (P01-12).

## 5. P04 — ambiente

**Painel por empresa:** `CentralConfiguracaoService.obterPainelCompleto(opcoes)` aceita `opcoes.empresa` ou `opcoes.empresaErro`. Quando a empresa é informada:
- `ambiente` vem de `obterContextoEmpresaPainel`, que usa `obterContextoOperacional({ empresaId, permitirFallbackGlobal:false })` no MULTIEMPRESA;
- a origem é `empresas_configuracao_fiscal`, com o rótulo "Configuração fiscal da empresa N";
- a configuração global (`getFiscalConfig`) **não é consultada** (P04-01, P04-05).

**Sem empresa no MULTIEMPRESA:**
- `ambiente.codigo = null`;
- `empresaContexto.estado = 'EMPRESA_NAO_SELECIONADA'`, com código `EMPRESA_CENTRAL_AUSENTE`;
- endpoints SEFAZ `null`;
- **sem Homologação padrão**.

**Empresa sem configuração válida:** `CONTEXTO_NAO_RESOLVIDO`, com a mensagem de causa.

**Controller:** `CentralConfiguracaoController.obter` resolve a empresa pelo `resolverEmpresaParaCentral` existente (seletor global / `X-Empresa-Id`). Uma falha de resolução vira estado explícito, nunca a configuração global.

**Texto "fonte oficial":**
- removido do backend: o painel legado sem empresa agora diz "Configuração fiscal global (Centro de Configurações)";
- removido da UI.

**Preservado:** `configuracoes.fiscal_ambiente` **não** foi alterado. `empresas_configuracao_fiscal.ambiente` não foi tocado (somente leitura). A chamada sem argumentos (`obterPainelCompleto()`) mantém o comportamento legado para os consumidores existentes (`atualizar`, `restaurarPadrao`, `CentralImportacaoXmlLegadoService`, `CentralDiagnosticoService`).

## 6. P09 — certificado

A seção `certificado` do painel com empresa vem do contexto da própria empresa, montada por `_montarVisaoCertificado`, que foi extraído de `_obterVisaoCertificado` e é reutilizado pelo legado.

**O que é exibido:**
- `empresaId`;
- `arquivo` (somente o nome do arquivo);
- `cnpj`;
- `status`;
- `validade` e `diasRestantes`, quando o parse é possível.

**O que não é exposto:**
- `caminho` completo (vai como `null` na visão por empresa);
- a senha, nunca (verificado por `semSegredo` nos testes).

**Estados sem certificado da empresa:**
- sem empresa: `status: EMPRESA_NAO_SELECIONADA`, `presente:false`;
- empresa desconhecida: `CONTEXTO_NAO_RESOLVIDO`;
- nunca aparece o certificado global nem o de outra empresa (P09-04, P09-05).

`certificadosFiliais` passa a ter o id `empresa:N`.

Nos testes, o carregador de certificado é injetado e os arquivos são textos fictícios em `DB_DIR`. **Nenhum PFX real é aberto.**

## 7. P14 — Gate 593 / fingerprint

Arquivo: `CentralSefazOperationalGate.js`, espelhando a estrutura do 656 por contexto da CE-04. O código do 656 não foi alterado.

**Estado 593 por empresa:** novo mapa `_estados593Contexto`, com chave `empresaId|cnpj|ambiente`.

**Novos métodos:**
- `registrarErro593Contexto`
- `obterEstado593Contexto`
- `estaSuspenso593Contexto`
- `limparErro593Contexto`
- `listarErros593PorEmpresa`
- `_avaliarCorrecao593Contexto`
- `avaliarBloqueioContexto` (leitura de 656 e 593 da empresa, sem efeitos colaterais)

**`processarRespostaSefaz`:** um 593 com contexto completo registra **somente** na empresa (`escopo: 'EMPRESA'`); o estado 593 global e o circuito global não mudam. Com contexto incompleto, segue o legado (`registrarErro593` global, circuito `CONFIG_ERROR`).

**`autorizarConsultaDistDfe`:**
- com contexto completo, consulta o 593 da empresa e **não** o global;
- sem contexto, usa o 593 global legado;
- o retorno do bloqueio 593 ganhou `escopo` e `empresaId`.

**Fingerprint:**
- `fingerprintFiscalDetalhado(ctxEmpresa)` e `fingerprintFiscalPadrao(ctxEmpresa)` usam `getFiscalConfig({ empresaId })` quando há empresa, e a leitura global quando não há;
- o 593 de cada empresa grava o fingerprint da própria empresa;
- a liberação ocorre quando o fingerprint **daquela** empresa muda (troca de certificado ou CNPJ);
- o tempo não libera, e a troca do certificado de outra empresa também não (P14-03);
- a validação de fingerprint e certificado foi mantida.

**Persistência:** `serializar()` inclui `erros593PorEmpresa`; `hidratar()` o restaura (P14-06).

**Telemetria:** `obterTelemetria()` expõe `erros593PorEmpresa`.

**Consumidores legados** (MIRX: `obterEstado593()` e `estaSuspenso593()` sem contexto) continuam lendo o estado global, sem alteração.

## 8. P15 — diagnóstico

**Resolução do contexto:** `CentralDiagnosticoService.testarConexaoSefaz(opcoes)` e `testarCertificado(opcoes)` resolvem o contexto por `_resolverContextoDiagnostico`.
- **Com empresa:** `obterContextoOperacional({ empresaId, permitirFallbackGlobal:false })` no MULTIEMPRESA.
- **Sem empresa no MULTIEMPRESA** (ou com `empresaErro`): **não executa**. Retorna `codigo: 'EMPRESA_CENTRAL_AUSENTE'` (código já existente) e `contextoEmpresaNaoSelecionado: true`, sem SOAP, sem contexto e sem NSU (P15-04).
- **Chamada legada sem argumentos:** só executa no `EMPRESA_SIMPLES`, que é o comportamento anterior.

**Gate:** o da empresa (`{ empresaId, cnpj, ambiente }`). Um bloqueio 656 ou 593 da empresa impede o SOAP (P15-05); outra empresa segue livre (P15-06).

**NSU:** `nsuRepository.buscarPorCnpjAmbiente(cnpj, ambiente)` da empresa. O cursor global `obterUltimaSincronizacao()` só é usado no caminho legado simples (P15-07).

**Resposta:** inclui `empresaId` e `cnpj`.

**Dependências injetáveis:** `configuracaoService`, `gate`, `enviarDistribuicaoDfe`, `carregarCertificado` e `obterModoOperacionalGlobal`. Os padrões continuam os mesmos de antes.

**Rotas:** `/configuracao/testar-sefaz` e `/configuracao/testar-certificado` (controller), e `/diagnostico/acoes/testar-sefaz` e `/diagnostico/acoes/testar-certificado`, que resolvem a empresa com `resolverEmpresaParaCentral`. O orchestrator e o `CentralEntradasService` apenas repassam as `opcoes`.

## 9. UI / seleção de empresa

Foi reutilizado o seletor global existente (`CdsEmpresaContexto`), **sem criar um novo seletor**.

- O card novo `renderContextoEmpresaCfg`, no topo da aba Ambiente, mostra **EMPRESA / CNPJ / AMBIENTE / CERTIFICADO** da empresa selecionada. O nome da empresa vem do seletor, e somente se for a mesma empresa do `empresaContexto`.
- **Sem empresa:** alerta pedindo para selecionar uma empresa no seletor do topo.
- **Contexto não resolvido:** alerta com a causa.
- O campo Ambiente mostra "Empresa não selecionada" / "Contexto não resolvido", em vez de "Homologação" por padrão.
- Textos "fonte oficial" removidos: nota da aba, rótulo "Origem do ambiente" e subtítulo do cabeçalho.
- `postConfigAcaoCentral` (Testar SEFAZ / Testar certificado) agora envia `X-Empresa-Id`. Antes não enviava, e o backend não sabia a empresa.
- O evento `cds-empresa-contexto-alterado` recarrega o painel de configuração quando ele está visível, então trocar de empresa atualiza os dados.
- `badgeCertStatusCfg` ganhou os estados `EMPRESA_NAO_SELECIONADA` e `CONTEXTO_NAO_RESOLVIDO`.

## 10. Arquivos alterados

**Backend:**

| Arquivo | Alteração |
|---|---|
| `backend/motores/central-entradas/services/CentralSefazOperationalGate.js` | P14 |
| `backend/motores/central-entradas/services/CentralManifestacaoDfeService.js` | P01: seleção, cota, ligação a `processarCandidatos`, dependência `obterModoOperacionalGlobal` |
| `backend/motores/central-entradas/repositories/CentralDocumentosRepository.js` | `listarPendentesManifestacao` |
| `backend/motores/central-entradas/contracts/CandidatoManifestacaoDTO.js` | somente o comentário do cabeçalho; lógica inalterada |
| `backend/motores/central-entradas/services/CentralConfiguracaoService.js` | P04/P09 |
| `backend/motores/central-entradas/controllers/CentralConfiguracaoController.js` | empresa da requisição no painel e nos testes |
| `backend/motores/central-entradas/services/CentralDiagnosticoService.js` | P15 |
| `backend/motores/central-entradas/CentralEntradasOrchestrator.js` | repasse de `opcoes` nos diagnósticos |
| `backend/motores/central-entradas/CentralEntradasService.js` | repasse de `opcoes` nos diagnósticos |
| `backend/rotas/central-entradas.js` | `/diagnostico/acoes/testar-*` com empresa |

**Frontend:**

| Arquivo | Alteração |
|---|---|
| `frontend/erp/js/central-entradas.js` | UI da seção 9 |

**Testes e scripts:**

| Arquivo | Alteração |
|---|---|
| `tests/central-entradas/central-entradas-06-multicnpj.test.js` | novo |
| `package.json` | script `test:central-entradas-06` |

## 11. Arquivos protegidos / não alterados

**Não alterados:**
- `CentralEntradasEmpresaContextoService` (somente consumido);
- `resolverContextoDocumentoCentral` (somente consumido);
- `distribuicaoDFe.js` (P19);
- Motor de Recuperação XML;
- RegistryBuilder e UrlResolver, e as URLs oficiais;
- `configService` fiscal;
- `certificateService`;
- `CentralNsuRepository`;
- `CentralXmlWaitScheduler`;
- MUC, MIIP, Motor Fiscal, Estoque, Financeiro, PDV, TEF, MBC, Motor de Composição e NFC-e.

**Preservado no comportamento:**
- **Gate 656 (CE-04):** código não alterado; cooldown e `proximaConsultaEm` intactos (P14-07 e CE-04 21/21).
- **Claim e TTL (CE-05):** apenas lidos na seleção.
- **P19:** não tocado.
- **Política de manifestação:** não tocada.
- **Locks da CE-04:** não tocados.
- **Pendências fora do escopo:** 48 tentativas / 30 dias e o estado terminal do 596 não foram alterados.

**Dados fiscais:** nenhuma alteração em `empresas_configuracao_fiscal.ambiente`, `configuracoes.fiscal_ambiente`, certificados PFX, CNPJs ou NSUs reais.

## 12. Testes novos

`tests/central-entradas/central-entradas-06-multicnpj.test.js`, com **42 testes**:

| Grupo | Testes |
|---|---|
| P01 | 15 (P01-01..15) |
| P04 | 6 |
| P09 | 6 |
| P14 | 7 |
| P15 | 8 |

**Isolamento:**
- `DB_DIR` temporário (a suíte aborta se apontar para o banco oficial);
- `database` substituído por SQLite `:memory:`;
- Gate isolado, com repositório em memória e relógio controlado;
- fingerprints fictícios por empresa;
- certificados fictícios (arquivos de texto; carregador injetado);
- SOAP simulado.

**Barreira:** `distribuicaoDfeRuntime.enviarDistribuicaoDfe` é substituído por uma função que **falha** se chamada, e a suíte verifica `SOAP real: 0`.

P01-01 e P01-15 exercitam `processarCandidatos` de ponta a ponta até `processarDocumento`, que é simulado.

## 13. Resultado individual

`npm run test:central-entradas-06` → **42 passou; 0 falhou. SOAP real: 0.** Passou na primeira execução.

## 14. Regressão CE-05

`central-entradas-05-seguranca.test` → **28 ok, 0 falha(s)**, igual à CE-05.

## 15. Regressão CE-04

`central-entradas-04-gate.test` → **21 ok, 0 falha(s)**.

## 16. Regressão CE-03

- `central-entradas-03-xml.test` → **17 ok, 0 falha(s)**
- `central-entradas-03-periodo.test` → **12 ok, 0 falha(s)**

## 17. Regressão geral

Todos os `tests/central-entradas/*.test.js`, cada um com seu próprio `DB_DIR` temporário. Logs e `resumo.csv` em `%TEMP%\ce06-reg-final\`.

| | CE-05 | CE-06 |
|---|---|---|
| Suítes | 80 | 81 (+ CE-06) |
| PASS | 51 | **52** (51 + CE-06) |
| FAIL | 29 | **29** |
| Acesso ao banco oficial nos logs | 0 | **0** |

**Comparação com os logs da CE-05:**
- Mesmo conjunto de suítes em falha.
- Suítes com mudança de código de saída: nenhuma, exceto a CE-06 (nova).
- Linhas de falha normalizadas (sem timestamps, durações e caminhos temporários; ruído `duplicate column tef_*` descartado): **idênticas nas 29 suítes**.
- Contagem de testes OK e FALHOU por suíte: **0 suítes com contagem diferente**. Isso descarta falhas novas mascaradas dentro de suítes que já falhavam.

**Falhas novas: nenhuma.**

## 18. Falhas pré-existentes

As 29 suítes abaixo já falhavam na CE-05, com as mesmas linhas de falha e as mesmas contagens:

> auditoria-leitores-globais-05-73, central-entradas-sprint2, sprint4, sprint5, sprint7, sprint9, sprint10,
> rc1-consolidacao, rc3-integridade, rc31-fonte-fiscal-unica, rc33-fechamento-ciclo-dfe, rc333-hardening,
> rc343, rc346, rc348, rc349a, rc3753, rc376, rc4-configuracao, rc40, rc6.2, rc6.4, rc6.5, rc74, rc741,
> rc742, rc743, rc75, rc833.

**Suítes que tocam as áreas alteradas nesta sprint** (as mesmas falhas da CE-05, com as mesmas mensagens):

- **rc31-fonte-fiscal-unica** (painel e UI): 7 ok e 1 falhou, "UI Central não coleta radios de ambiente". A asserção `js.includes('Configurações Avançadas')` já falhava antes: o texto já não existia na UI.
- **rc4-configuracao** (painel): 13 ok e 1 falhou, "sync retorna codigoErro amigável sem 502 semântico".
- **rc33-fechamento-ciclo-dfe** (`processarCandidatos`): 10 passou e 1 falhou, "cooldown persistido bloqueia distNSU…". O teste que usa `processarCandidatos` ("após Ciência não consulta DistDFe imediatamente") **passa** com a nova seleção.
- **rc333-hardening:** 5 passou e 1 falhou (mutex, condição de tempo conhecida).
- **rc741, rc742, rc743** (Gate): as mesmas falhas e as mesmas contagens da CE-05.

## 19. Banco oficial

- **Não aberto.** Todos os comandos de teste rodaram com `DB_DIR` temporário, um por suíte.
- Nenhum log contém `MercantilFiscal\dados\mercadao.db`.
- A suíte CE-06 aborta se `DB_DIR` apontar para o banco oficial.
- Nenhum `node -e` foi usado com o carregamento do backend.

## 20. Chamadas SEFAZ

**Zero chamadas reais:**
- nenhum 210210;
- nenhum distNSU;
- nenhum consChNFe;
- nenhuma recuperação de XML real;
- nenhum PFX real aberto.

O único transporte usado foi o simulado (`https://mock.sefaz.invalid/...`). A barreira da CE-06 confirmou `SOAP real: 0`.

## 21. Pendências

1. **Limite de avaliação do P01:** 500 documentos por ciclo, dos mais recentes por emissão. Como só os emitidos nos últimos 10 dias podem estar no prazo, esse limite só seria atingido com mais de 500 pendentes `AGUARDANDO_XML_COMPLETO` emitidos em 10 dias.
2. **Custo da seleção:** até 4 leituras de evento por documento avaliado. É aceitável para o volume atual; um índice ou consulta agregada pode ser avaliado se o volume crescer.
3. **Documentos com 596 e `CIENCIA_ACEITA`** deixaram de ser tocados por `processarCandidatos`, porque não estão pendentes de ciência. A recuperação de XML deles continua sob o Motor de Recuperação e o XML_WAIT, sem alteração.
4. **MIRX e demais leitores globais do 593** (`obterEstado593()` sem contexto) veem apenas o 593 legado. Um 593 por empresa aparece em `erros593PorEmpresa` na telemetria, mas o MIRX não foi adaptado (fora do escopo).
5. **O painel de diagnóstico geral** (`CentralDiagnosticoService.obterPainelCompleto` / `_obterCertificado`) continua exibindo a visão global. Somente as ações Testar SEFAZ e Testar certificado passaram a ser por empresa.
6. **UI validada apenas por sintaxe** (`node --check`) e revisão; não houve teste em navegador nesta sprint.
7. **Continuam fora do escopo:** 48 tentativas / 30 dias, estado terminal do 596, `rc333-hardening` e as 29 suítes pré-existentes.

## 22. Conclusão

Condições de fechamento atendidas:

- 42/42 testes novos passando.
- CE-03 (17 + 12), CE-04 (21) e CE-05 (28) passando.
- Nenhuma falha nova: as mesmas 29 suítes pré-existentes, com linhas e contagens idênticas.
- P01 ligado a `processarCandidatos`, com elegibilidade, urgência, cota por empresa e limite preservado.
- Painel por empresa (ambiente e certificado), sem fallback global no MULTIEMPRESA e sem expor senha.
- Diagnóstico exige empresa no MULTIEMPRESA e usa o contexto, o Gate e o NSU da empresa.
- 593 com contexto completo bloqueia apenas a empresa afetada; o legado global foi mantido para contexto incompleto; o 656 da CE-04 está inalterado.
- Nenhuma configuração fiscal real alterada, nenhuma chamada SEFAZ real, banco oficial não aberto.

**Produção não é declarada homologada.** Nenhum teste real em Produção foi executado. Conforme instruído, a sprint
para aqui: nenhuma nova alteração será feita antes da análise deste relatório.
