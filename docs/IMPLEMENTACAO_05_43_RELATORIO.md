# SPRINT 05.43

## OBJETIVO

Corrigir o risco confirmado na auditoria 05.39 no fluxo DistDFe: `persistirDocumentosRetorno` lia `deps` fora de escopo, podendo falhar a ingestão de documentos DF-e de forma silenciosa.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/services/fiscal/distribuicaoDFe.js` | Causa + correção + chamadores + log estrutural |
| `tests/fiscal/distdfe-blindagem-05-43.test.js` | **Novo** — reprodução, sucesso, falha, NSU, idempotência, lote vazio |
| `docs/arquitetura/DISTDFE_BLINDAGEM_05_43.md` | **Novo** |
| `docs/IMPLEMENTACAO_05_43_RELATORIO.md` | **Novo** |

Não alterados (fora de escopo): Motor Comercial, PDV Express, MotorTEF, NFC-e, estoque, financeiro, lotes/FEFO, reservas, compras, MIIP, Central de Entradas (regras), `CentralNsuService`.

## CAUSA REAL ENCONTRADA

`ReferenceError: deps is not defined` em `persistirDocumentosRetorno`.

A função recebia `(xmlRetorno, persistencia, origem, ctxAudit)` e avaliava `deps.contextoCentral?.empresaId` no loop. `deps` não existia nesse escopo. O `catch` incrementava `ignorados` e seguia. `persistirDocumentoDfe` não era chamado. A sincronização tratava o lote como processado (`sucesso: true`) e podia avançar NSU.

Não era certificado, SOAP ou regra fiscal. Era escopo/assinatura inconsistente.

## CORREÇÃO APLICADA

1. `empresaId` resolvido por `ctxAudit.empresaId ?? persistencia._empresaId ?? null` (mecanismo já existente).
2. Chamadores (`sincronizarDistribuicaoDFe`, `consultarNotaPorChave`) passam `empresaId` no `ctxAudit` a partir de `deps` **deles**.
3. Persistência ausente/inválida lança `DISTDFE_PERSISTENCIA_AUSENTE` (sem fallback silencioso).
4. `ReferenceError` e códigos estruturais DistDFe são relançados; não viram `ignorados`.
5. Log de falha: etapa, código, NSU, origem, mensagem. Sem certificado, senha, token, CSC ou chave privada.

## TESTES CRIADOS

`tests/fiscal/distdfe-blindagem-05-43.test.js`

1. Reprodução do `ReferenceError` original + garantia de que o persist agora é chamado
2. Dependências válidas → persistência real e `empresaId` aplicado
3. Persistência ausente → erro explícito, sem sucesso falso
4. Falha no meio do processamento → documento não conta como novo
5. NSU avança só após persistência concluída; falha estrutural não aplica NSU
6. Idempotência no caminho auditado
7. Sem novos documentos (cStat 137) — comportamento normal preservado

## TESTES EXECUTADOS

| Suite | Executados | OK | Falha |
|-------|------------|----|-------|
| `tests/fiscal/distdfe-blindagem-05-43.test.js` | 8 | 8 | 0 |
| `tests/services/fiscal/dfeRetornoParser.test.js` | 8 | 8 | 0 |
| `tests/fiscal/fiscal-dfe-runtime.test.js` | 11 | 11 | 0 |
| `tests/fiscal/rc36e-dfe-observabilidade.test.js` | 6 | 6 | 0 |
| **Total desta verificação** | **33** | **33** | **0** |

Suítes RC3.1 (UI “Configurações Avançadas”) e RC3.3 (`AGUARDAR_JANELA_DFE` em `CentralSyncExecucaoService`) falharam em pontos **não tocados** por esta sprint (frontend Central e cooldown de sync). Não fazem parte da correção DistDFe/`deps`.

## RESULTADO

Correção no menor ponto. Ingestão DistDFe volta a chamar `persistirDocumentoDfe` com `empresaId`. Falha estrutural não parece sucesso.

## COMPORTAMENTO DE ERRO

- Persistência indisponível: `DISTDFE_PERSISTENCIA_AUSENTE`, log estrutural, NSU não avança, sync relança.
- Erro por documento (banco): `ignorados++`, log com etapa/NSU/código, auditoria `ERRO_BANCO`; o documento não entra em `notasNovas`.
- Sem catch vazio e sem objeto `{}` no lugar de dependência ausente.

## COMPORTAMENTO DE SUCESSO

Documento processável + persistência válida → `persistirDocumentoDfe` é chamado, `notasNovas`/`duplicado`/`atualizado` conforme retorno real, telemetria de sucesso e `aplicarRetornoDistDfe` na ordem já existente.

## RISCOS REMANESCENTES (reais)

- Erro **por documento** (banco) continua não bloqueando o avanço de NSU do lote — política DistDFe já existente, não alterada.
- `empresaId` ainda pode ser `null` se o chamador não vier da Central (`contextoCentral` / `_empresaId` ausentes). Isso é o caminho legado, não o bug `deps`.
- Eventos ZIP (`aplicarEventoDfe`) preservam o `catch` com `console.warn` pré-existente; fora do bug `deps`.
