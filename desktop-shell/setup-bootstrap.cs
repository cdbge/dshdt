// DSH Desktop self-extracting installer bootstrap (compiled by csc.exe)
// Embedded zip payload -> extract to %TEMP%\dsh-setup-tmp -> run setup.cmd
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

internal static class Setup
{
    [STAThread]
    private static int Main()
    {
        string work = Path.Combine(Path.GetTempPath(), "dsh-setup-tmp");
        try
        {
            if (Directory.Exists(work)) { Directory.Delete(work, true); }
            Directory.CreateDirectory(work);

            string zip = Path.Combine(work, "payload.zip");
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload"))
            {
                if (s == null) { throw new InvalidOperationException("embedded payload missing"); }
                using (FileStream f = File.Create(zip)) { s.CopyTo(f); }
            }
            ZipFile.ExtractToDirectory(zip, work);
            File.Delete(zip);

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "cmd.exe";
            psi.Arguments = "/c setup.cmd";
            psi.WorkingDirectory = work;
            psi.UseShellExecute = true;
            using (Process p = Process.Start(psi)) { p.WaitForExit(); }

            // delayed cleanup (best effort; setup.cmd may still hold cwd briefly)
            try { Directory.Delete(work, true); } catch { }
            return 0;
        }
        catch (Exception ex)
        {
            try { MessageBox.Show("Installation failed: " + ex.Message, "DSH Desktop", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            catch { }
            return 1;
        }
    }
}
