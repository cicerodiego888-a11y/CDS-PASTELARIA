# Isolamento da chave de compra na Central (Sprint 05.68)

**Status:** implementação  
**Data:** 2026-08-29

## 1. Função encontrada

`CentralDfePersistenciaService.existeCompraComChave(chave, empresaId)`  
Arquivo: `backend/motores/central-entradas/services/CentralDfePersistenciaService.js`

Contrato preservado: retorno `boolean`. Sem chave ou sem empresa inteira válida → `false`.

## 2. Chamadores

| Arquivo | Função / papel | Rota/serviço | Origem da empresa | Tem empresaId? | Pode sem empresa? | Fluxo Central? |
|---------|----------------|--------------|-------------------|----------------|-------------------|----------------|
| `CentralDfePersistenciaService.js` | `persistirDocumentoDfe` | DistDFe, sync, upload | `dados.empresaId` ?? `this._empresaId` | sim, quando o fluxo resolve alvo | sim: então `false`, sem SELECT global | sim |
| `CentralSincronizacaoService.js` | instancia persistência | sync por alvo 05.54 | `{ empresaId }` do alvo | sim | não no caminho oficial de alvos | sim |
| DistDFe (`distribuicaoDFe`) | `persistirDocumentoDfe({ empresaId })` | distribuição | `empresaIdPersistencia` | sim no persist | depende do caller | sim |
| `CentralUploadService.js` | persistência de XML | upload | `empresaResolvida.empresaId` | sim | rejeição anterior se não resolver | sim |
| `ReleaseCertificationService.js`, homologação, testes rc6.x | mock `async () => false` | certificação | n/a | n/a | mock | teste |

POST `/api/compras` **não** chama esta função (isolada na 05.67).

Não foram alterados outros chamadores além da assinatura opcional `empresaId` (mocks continuam compatíveis).

## 3. Consulta anterior

```sql
SELECT id FROM compras WHERE chave_acesso = ? LIMIT 1
```

Global. Empresa A + chave X era visível para a Central da empresa B.

## 4. Consulta nova

```sql
SELECT id FROM compras WHERE chave_acesso = ? AND empresa_id = ? LIMIT 1
```

Parâmetros: `[chave, emp]` com `emp` inteiro > 0.

## 5. Origem do `empresaId`

Não se lê `X-Empresa-Id` nesta função.

Ordem na persistência DistDFe:

1. `dados.empresaId` (já resolvido pelo caller: alvo de sync, DistDFe, upload);
2. senão `this._empresaId` (ctor — `CentralSincronizacaoService` passa o alvo 05.54).

MULTIEMPRESA: `alvo.empresaId` via ctor/dados.  
EMPRESA_SIMPLES: empresa operacional do contrato, já injetada no mesmo caminho (sem fallback extra nesta sprint).

Não usa primeira/última empresa, empresa 1, `empresa_operacional_id` como substituto do alvo MULTIEMPRESA, CNPJ global, usuário ou COMPAT.

## 6. EMPRESA_SIMPLES

Se o contrato resolve `empresa_operacional = A`, a sync/persistência recebe `empresaId = A`. A consulta usa `empresa_id = A`. Sem COALESCE e sem novo fallback.

## 7. MULTIEMPRESA

Cada sincronização é por alvo (`listarAlvosSincronizacaoCentral`). A duplicidade de compra é `chave + empresaId` daquele alvo. A+X, B+X e C+X podem coexistir; cada alvo encontra só o próprio registro.

## 8. Empresa A + chave X

Central com alvo A: `true` (duplicidade / já comprada naquele alvo).

## 9. Empresa B + chave X

Compra só em A: Central B → `false`. Não devolve `id`, fornecedor, empresa nem linha da compra A.

## 10. NULL

`empresa_id IS NULL` + chave X: `AND empresa_id = A` não casa. Não vira compra da A. Sem COALESCE.

Se a Central não tem empresa resolvida para a consulta: `false`, sem SELECT só por chave.

## 11. Ausência de vazamento

A função continua boolean. Cruzado não retorna registro. `persistirDocumentoDfe` só usa o boolean para status `IMPORTADA` (“já registrada em compras”), sem anexar dados da compra de outra empresa.

## 12. Riscos restantes

- Duplicidade de **documento** na Central (`central_entradas_documentos` / `buscarPorChave`) — fora do escopo.
- Classificador histórico de CNPJ em compras (05.65 T09).
- UPDATE de devolução de compra só por `id` (defesa em profundidade).
- `carregarCompraCabecalho` interno da NF-e devolução ainda por `id`.
- GET lista de compras agrega NF-e devolução só por `compra_id`.
