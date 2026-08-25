# PLANO DE REAPROVEITAMENTO — Compras 05.38.F.A

**Classificação:** SOMENTE LEITURA — sem implementação  
**Objetivo:** orientar 05.38.F.B sem criar abstrações novas nesta auditoria

---

## JÁ EXISTE E REUTILIZAR

| Componente | Uso futuro sugerido |
|------------|---------------------|
| `ContratoOperacionalService` | EMPRESA_SIMPLES → empresa operacional na criação/consulta |
| `empresaContexto` / `criarMiddlewareContextoEmpresa` | Já no router; evoluir `obrigatorio` conforme modo |
| `FinanceiroEmpresaContextoService` | Já na fronteira financeiro da compra |
| `creditoEstoqueCompraViaPorta` / `debitoEstoqueCompraViaPorta` | Manter porta; exigir empresa em MULTI |
| `estoque_empresa` + `estoqueSaldosPublico` | Destino oficial com `empresaId` |
| `CentralEntradasEmpresaContextoService` | Validar documento × empresa da operação |
| `CentralComprasBridgeService` | Propagar e validar `empresaId` no vincular |
| `CdsEmpresaContexto` + `$.ajaxSetup` | Header HTTP existente no ERP |
| INSERT único em `rotas/compras.js` | Evoluir colunas; não criar segundo writer |
| `EmpresaService` / `UsuarioEmpresaService` | Validação ativa + vínculo |

---

## EXISTE MAS PRECISA CONECTAR

| Peça | Conexão faltante |
|------|------------------|
| `central_entradas_documentos.empresa_id` | → persistir na compra + validar no POST |
| Payload `dadosCompra.empresaId` (bridge) | → frontend incluir no POST **ou** backend preferir doc Central |
| `req.empresaId` | → coluna `compras.empresa_id` no INSERT |
| Listagens GET | → filtro por empresa (SIMPLES automático / MULTI contexto) |
| Cancelar/devolver/detalhe | → `exigirRegistroDaEmpresa` padrão financeiro |
| `vincularDocumentoCentralAposCompra` | → passar `empresaId` real da operação |

---

## PRECISA CENTRALIZAR

| Tema | Recomendação |
|------|--------------|
| Resolução única “empresa da compra” | Preferência: documento Central > body explícito > req/header > Contrato SIMPLES |
| Alinhar estoque e financeiro | Mesma `empresa_id` resolvida **antes** do BEGIN e reutilizada |
| Evitar COMPAT legado em MULTI | `exigirEmpresa: true` quando modo MULTIEMPRESA |

**Não criar** `ComprasEmpresaContextoService` nesta auditoria; se F.B precisar, espelhar o padrão fino de Caixa/Financeiro/Central (adaptador, não motor).

---

## DUPLICADO

| Item | Ação |
|------|------|
| `POST /parse-xml` (410) | Manter deprecated; não reativar |
| Duas resoluções empresa (estoque vs financeiro) | Unificar entrada na gravação |

---

## AUSENTE (para 05.38.F.B)

1. Coluna `compras.empresa_id` (+ índice + backfill seguro).  
2. Filtro de listagem/relatório por empresa.  
3. Guard de ownership em GET/:id, cancelar, devolver.  
4. Frontend: não depender só do seletor quando origem Central (validar destinatário).  
5. Testes 05.38.F.B cobrindo documento A ≠ contexto B.

---

## Ordem sugerida (sem implementar agora)

1. Schema + backfill (SIMPLES seguro; MULTI sem inventar).  
2. INSERT + resolução única na `POST /`.  
3. Guardas de leitura/cancel/devolver.  
4. Vincular Central com validação real.  
5. Listagens.  
6. Endurecer estoque MULTI (`exigirEmpresa`).  
7. Testes + docs ESTADO B.
