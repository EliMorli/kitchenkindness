export async function GET() {
    const deployHookUrl = process.env.DEPLOY_HOOK_URL;

  if (!deployHookUrl) {
        return Response.json({ 
                                   success: false, 
                error: 'DEPLOY_HOOK_URL environment variable not set' 
        }, { status: 500 });
  }

  try {
        const response = await fetch(deployHookUrl, { method: 'POST' });

      return Response.json({ 
                                 success: response.ok,
              triggered: new Date().toISOString()
      });
  } catch (error) {
        return Response.json({ 
                                   success: false, 
                error: error.message 
        }, { status: 500 });
  }
}
