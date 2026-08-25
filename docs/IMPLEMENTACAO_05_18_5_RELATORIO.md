# Relatório — Sprint 05.18.5

## STATUS DA SPRINT

**ESTADO B — IMPLEMENTAÇÃO PRONTA, VALIDAÇÃO OPERACIONAL PENDENTE**

Não 100% concluída. Não iniciar próxima sprint visando ESTADO A sem login HTTP ou percurso visual assistido.

--------------------------------

## AMBIENTE REAL

Servidor: `npm start` (Electron + backend)  
URL: `http://127.0.0.1:3001`  
Porta: **3001**  
Disponível: **SIM**

--------------------------------

## LOGIN REAL

Executado: **PARCIAL**

- Electron: login ocorreu (log `AUTH_LOGIN_DURATION` no servidor).
- HTTP API: **NÃO** (401 nos candidatos conhecidos). Sem token. Sem senha do operador.

--------------------------------

## GESTÃO DE EMPRESAS

Executada visualmente: **NÃO** (sem controle da janela Electron)

Versão do módulo: **05.18** (arquivo servido)  
Arquivo carregado: `/erp/js/gestao-empresas-fiscal.js?v=05172`

Sidebar ao vivo: Empresas **não** é item lateral; Configurações Avançadas **sim**.

--------------------------------

## EMPRESA A

Dados gerais: não preenchidos pelo agente  
Configuração fiscal: não  
CSC: não  
Certificado: não  
Persistência: não (HTTP autenticado indisponível)

--------------------------------

## EMPRESA B

Idem Empresa A.

--------------------------------

## ISOLAMENTO A ≠ B

**NÃO COMPROVADO** em HTTP/UI reais nesta sprint.  
Comprovado apenas em testes Node anteriores (05.18.3 / 05.18.4).

--------------------------------

## HTTP REAL

GET Empresas: **401** (sem token)  
GET Fiscal: não executado (sem auth)  
PUT Fiscal: não executado  
Status: servidor no ar; APIs protegidas corretamente

--------------------------------

## PDV UNIVERSAL

Acesso real: GET `/pdv-universal/` → **200**  
Contexto real: GET `/api/pdv-universal/contexto` **não** executado (sem token)  
Status: HTML oficial no ar

--------------------------------

## CORREÇÕES REALIZADAS

Nenhuma correção de runtime. Nenhuma falha de rota/cache/`/api/api` no que foi exercitado.

--------------------------------

## TESTES AUTOMATIZADOS

Probe: `tests/fiscal/assistida-ambiente-real-05-18-5.js`  
Regressão Node: manter 04.09, 05.11, 05.18–05.18.4 (sem nova arquitetura).

--------------------------------

## PENDÊNCIAS REAIS

1. Operador: abrir Configurações Avançadas → Empresas e confirmar as três áreas + URLs.
2. Fornecer sessão HTTP (login do ambiente) para GET/PUT A e B.
3. Upload PFX de teste, se houver arquivo.
4. GET `/api/pdv-universal/contexto` autenticado.
5. Isolamento A≠B no banco oficial via API autenticada.
