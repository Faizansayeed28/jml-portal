using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Identity.Web;
using System.Security.Claims;
using Microsoft.AspNetCore.DataProtection;
using System.Text.Json.Serialization;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<JmlDb>(o => o.UseSqlite("Data Source=jml.db"));
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo("keys"))
    .SetApplicationName("jml");
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173").AllowAnyHeader().AllowAnyMethod()));
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddMicrosoftIdentityWebApi(builder.Configuration.GetSection("AzureAd"));
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("HrOnly", p => p.RequireRole("JML.HR"))
    .AddPolicy("AgentOnly", p => p.RequireRole("JML.Agent"));

var app = builder.Build();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

using (var scope = app.Services.CreateScope())
{
    scope.ServiceProvider.GetRequiredService<JmlDb>().Database.EnsureCreated();
}

app.MapGet("/api/batches", async (JmlDb db) =>
    await db.Batches
        .OrderByDescending(b => b.UploadedAt)
        .Select(b => new
        {
            b.Id, b.FileName, b.UploadedBy, b.UploadedAt, b.Type,
            Total = b.Items.Count,
            Pending = b.Items.Count(i => i.Status == "Pending"),
            Success = b.Items.Count(i => i.Status == "Success"),
            Failed = b.Items.Count(i => i.Status == "Failed")
        }).ToListAsync()).RequireAuthorization("HrOnly");

app.MapGet("/api/batches/{id}/items", async (int id, JmlDb db) =>
    await db.Items.Where(i => i.BatchId == id).ToListAsync()).RequireAuthorization("HrOnly");

app.MapPost("/api/batches", async (IFormFile file, JmlDb db, ClaimsPrincipal user) =>
{
    using var reader = new StreamReader(file.OpenReadStream());
    var header = (await reader.ReadLineAsync())?.Trim().TrimStart('\uFEFF');
    if (header != "FirstName,LastName,Department,JobTitle,Manager")
        return Results.BadRequest(new { errors = new[] { "Header must be: FirstName,LastName,Department,JobTitle,Manager" } });

    var batch = new UploadBatch { FileName = file.FileName, UploadedBy = user.FindFirst("preferred_username")?.Value
    ?? user.FindFirst("upn")?.Value
    ?? user.FindFirst("name")?.Value
    ?? "unknown", UploadedAt = DateTime.UtcNow, Type = "Joiner" };
    var errors = new List<string>();
    var rowNo = 1;
    string? line;
    while ((line = await reader.ReadLineAsync()) != null)
    {
        if (string.IsNullOrWhiteSpace(line)) continue;
        rowNo++;
        var p = line.Split(',');
        if (p.Length != 5 || string.IsNullOrWhiteSpace(p[0]) || string.IsNullOrWhiteSpace(p[1]))
        {
            errors.Add($"Row {rowNo}: needs 5 columns and a first and last name");
            continue;
        }
        batch.Items.Add(new JobItem
        {
            FirstName = p[0].Trim(), LastName = p[1].Trim(), Department = p[2].Trim(),
            JobTitle = p[3].Trim(), Manager = p[4].Trim()
        });
    }
    if (errors.Count > 0) return Results.BadRequest(new { errors });
    if (batch.Items.Count == 0) return Results.BadRequest(new { errors = new[] { "File has no data rows" } });

    db.Batches.Add(batch);
    await db.SaveChangesAsync();
    return Results.Ok(new { batch.Id, Count = batch.Items.Count });
}).DisableAntiforgery().RequireAuthorization("HrOnly");


app.MapPost("/api/agent/claim", async (JmlDb db) =>
{
    var items = await db.Items
        .Where(i => i.Status == "Pending")
        .OrderBy(i => i.Id)
        .Take(10)
        .ToListAsync();
    foreach (var i in items) i.Status = "Processing";
    await db.SaveChangesAsync();
    return items;
}).RequireAuthorization("AgentOnly");

app.MapPost("/api/agent/items/{id}/result", async (int id, ResultDto dto, JmlDb db, IDataProtectionProvider dp) =>
{
    var item = await db.Items.FindAsync(id);
    if (item == null) return Results.NotFound();
    item.Status = dto.Status == "Success" ? "Success" : "Failed";
    item.ErrorMessage = dto.ErrorMessage;
    item.SamAccountName = dto.SamAccountName;
    item.UserPrincipalName = dto.UserPrincipalName;
    if (!string.IsNullOrEmpty(dto.TempPassword))
        item.SecretProtected = dp.CreateProtector("jml.temp-password").Protect(dto.TempPassword);
    item.ProcessedAt = DateTime.UtcNow;
    await db.SaveChangesAsync();
    return Results.Ok();
}).RequireAuthorization("AgentOnly");

app.MapPost("/api/items/{id}/reveal-password", async (int id, JmlDb db, IDataProtectionProvider dp, ClaimsPrincipal user) =>
{
    var item = await db.Items.FindAsync(id);
    if (item?.SecretProtected == null)
        return Results.NotFound(new { error = "No password available. It was already revealed." });

    var password = dp.CreateProtector("jml.temp-password").Unprotect(item.SecretProtected);
    item.SecretProtected = null;
    item.PasswordRevealedBy = user.FindFirst("preferred_username")?.Value
        ?? user.FindFirst("upn")?.Value
        ?? user.FindFirst("name")?.Value
        ?? "unknown";
    item.PasswordRevealedAt = DateTime.UtcNow;
    await db.SaveChangesAsync();
    return Results.Ok(new { item.SamAccountName, item.UserPrincipalName, password });
}).RequireAuthorization("HrOnly");

app.Run();

public class JmlDb : DbContext
{
    public JmlDb(DbContextOptions<JmlDb> options) : base(options) { }
    public DbSet<UploadBatch> Batches => Set<UploadBatch>();
    public DbSet<JobItem> Items => Set<JobItem>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<UploadBatch>()
            .HasMany(b => b.Items)
            .WithOne()
            .HasForeignKey(i => i.BatchId);
    }
}

public class UploadBatch
{
    public int Id { get; set; }
    public string FileName { get; set; } = "";
    public string UploadedBy { get; set; } = "";
    public DateTime UploadedAt { get; set; }
    public string Type { get; set; } = "Joiner";
    public List<JobItem> Items { get; set; } = new();
}

public class JobItem
{
    public int Id { get; set; }
    public int BatchId { get; set; }
    public string FirstName { get; set; } = "";
    public string LastName { get; set; } = "";
    public string Department { get; set; } = "";
    public string JobTitle { get; set; } = "";
    public string Manager { get; set; } = "";
    public string Status { get; set; } = "Pending";
    public string? ErrorMessage { get; set; }
    public DateTime? ProcessedAt { get; set; }
    public string? SamAccountName { get; set; }
    public string? UserPrincipalName { get; set; }
    [JsonIgnore] public string? SecretProtected { get; set; }
    public string? PasswordRevealedBy { get; set; }
    public DateTime? PasswordRevealedAt { get; set; }
    public bool HasPassword => SecretProtected != null;
}

public record ResultDto(string Status, string? ErrorMessage, string? SamAccountName, string? UserPrincipalName, string? TempPassword);