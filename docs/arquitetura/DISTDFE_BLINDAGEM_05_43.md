# BLINDAGEM DISTDFE — Sprint 05.43

**Status:** implementado  
**Data:** 2026-08-25  
**Dependência:** auditoria 05.39 (risco confirmado no fluxo DistDFe)

## 1. Fluxo real identificado

A ingestão DistDFe **não** vive em um único arquivo. O caminho real é:

```
SEFAZ (Distribuição DF-e)
   ↓
sincronizarDistribuicaoDFe / consultarNotaPorChave
   (backend/services/fiscal/distribuicaoDFe.js)
   ↓
requisição SOAP (executarEnvioConsultaDfe)
   ↓
recebimento do lote (XML retDistDFeInt + docZip)
   ↓
extrairDocumentosZip (dfeRetornoParser.js)
   ↓
persistirDocumentosRetorno
   ↓
CentralDfePersistenciaService.persistirDocumentoDfe
   ↓
Central de Entradas (inbox)
   ↓  (somente após persistirDocumentosRetorno retornar)
CentralNsuService.aplicarRetornoDistDfe
```

`deps` existe nas funções de orquestração (`sincronizarDistribuicaoDFe`, `consultarNotaPorChave`, `executarEnvioConsultaDfe`). Dependências esperadas nesse nível:

- `contextoCentral` (certificado, CNPJ, UF, ambiente, `empresaId`)
- `persistenciaService` (`CentralDfePersistenciaService`, já com `_empresaId`)
- `nsuService` / `nsuRepository`
- `enviarDistribuicaoDfe` (injeção de teste / runtime)
- `auditoriaService`

A Central já monta persistência com empresa:

`CentralSincronizacaoService` → `new CentralDfePersistenciaService({ empresaId })` + `contextoCentral.empresaId`.

MIIP, compras e pipeline fiscal **não** são chamados neste arquivo. DistDFe só alimenta a inbox.

## 2. Ponto exato do bug

Arquivo: `backend/services/fiscal/distribuicaoDFe.js`  
Função: `persistirDocumentosRetorno(xmlRetorno, persistencia, origem, ctxAudit)`  
Leitura inválida: `deps.contextoCentral?.empresaId` **dentro** do loop de documentos.

`deps` **não** era parâmetro dessa função. Não havia shadowing: era variável inexistente no escopo.

Chamadores:

- `sincronizarDistribuicaoDFe` (passava `ctxAudit` sem `empresaId`)
- `consultarNotaPorChave` (não passava `ctxAudit`)

## 3. Causa real

**ReferenceError: `deps is not defined`.**

A avaliação de `empresaId` ocorria **antes** de `persistirDocumentoDfe` ser invocado. O `catch` do loop tratava qualquer erro como documento ignorado (`ignorados += 1; continue`).

Não era ausência do cliente SEFAZ, nem certificado, nem regra fiscal. Era assinatura/escopo inconsistente.

## 4. Comportamento antes

1. Lote DistDFe válido chegava.
2. ZIP era extraído.
3. No primeiro documento, `deps.contextoCentral` lançava `ReferenceError`.
4. O documento era contado como `ignorados`.
5. `persistirDocumentoDfe` **não era chamado**.
6. A função retornava `{ notasNovas: 0, ignorados: N }` — aparente “lote processado, nada novo”.
7. `sincronizarDistribuicaoDFe` marcava telemetria `sucesso: true` e chamava `aplicarRetornoDistDfe`.

Falha real virava sucesso falso. NSU podia avançar sem ingestão.

## 5. Comportamento depois

`persistirDocumentosRetorno` **não lê `deps`**. `empresaId` vem do contexto já existente:

```
ctxAudit.empresaId
  ?? persistencia._empresaId
  ?? null
```

Chamadores passam `empresaId` em `ctxAudit` a partir de `deps.contextoCentral.empresaId` (onde `deps` **existe**) ou de `persistencia._empresaId`.

Se houver documentos ZIP e a persistência não tiver `persistirDocumentoDfe`:

```
DISTDFE_PERSISTENCIA_AUSENTE
```

Erro explícito. Sem objeto vazio como fallback. Sem optional chaining para esconder `deps` ausente.

## 6. Tratamento de falhas

| Situação | Resultado |
|----------|-----------|
| Sucesso de persistência (`novo` / `duplicado` / `atualizado` / `ignorado` de negócio) | Contadores reais; lote segue |
| Persistência ausente / inválida / `ReferenceError` | Relança; sync **não** retorna sucesso; NSU **não** aplica |
| Erro por documento (ex.: banco) | `ignorados++`, log com etapa/código/NSU, auditoria `ERRO_BANCO`; **não** conta `notasNovas` |
| cStat de sucesso sem ZIP | Retorno vazio normal; sem exceção falsa |

Não há catch vazio. Não há sucesso falso para falha estrutural.

## 7. Comportamento de estado/NSU

Política **existente** (não reescrita):

- `aplicarRetornoDistDfe` roda **depois** de `persistirDocumentosRetorno` retornar.
- cStat 656: NSU preservado / recuperação + cooldown (inalterado).
- cStat 137/138 com lote vazio: DistDFe consome o cursor SEFAZ (inalterado).
- Erro por documento (negócio/banco) **não** bloqueia o avanço de NSU do lote (inalterado).

Correção ligada ao bug:

- Falha estrutural (`DISTDFE_PERSISTENCIA_AUSENTE` / `ReferenceError`) **propaga**.
- O `catch` externo do sync **não** chama `aplicarRetornoDistDfe` e não marca `sucesso: true`.

Não foi criada política nova de NSU. Só se impediu avançar o cursor quando a persistência estrutural falhou — o caso que a auditoria 05.39 descreveu.

## 8. Idempotência preservada

`CentralDfePersistenciaService.persistirDocumentoDfe` continua devolvendo `duplicado` / `atualizado` / `ignorado` sem novo INSERT quando o documento já existe.

A correção não remove essa proteção. O teste 6 cobre o caminho auditado: segundo processamento do mesmo XML não duplica efeito.

## 9. Arquivos envolvidos

| Arquivo | Papel |
|---------|--------|
| `backend/services/fiscal/distribuicaoDFe.js` | Causa, correção, chamadores |
| `backend/services/fiscal/dfeRetornoParser.js` | Extração ZIP (não alterado) |
| `backend/motores/central-entradas/services/CentralDfePersistenciaService.js` | Persistência / idempotência (não alterado) |
| `backend/motores/central-entradas/services/CentralSincronizacaoService.js` | Injeta `deps` com `empresaId` (não alterado) |
| `backend/motores/central-entradas/services/CentralNsuService.js` | Avanço de NSU (não alterado) |
| `tests/fiscal/distdfe-blindagem-05-43.test.js` | Suíte 05.43 |

Fora de escopo e **não** alterados: Motor Comercial, PDV, TEF, NFC-e, estoque, financeiro, lotes/FEFO, reservas, compras, MIIP.
